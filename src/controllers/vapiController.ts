"use strict";

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const { handleRouting: routingHandler } = require("../state-machine/router");
const { CallState: CallStateMap } = require("../types");
const { parseEndOfCallReport } = require("../services/leadParser");
const { dispatchLead } = require("../services/crmMock");
const { pushEvent } = require("../ws/broadcaster");
const logger = require("../utils/logger");

// Ensure logs directory exists
const LOGS_DIR = path.join(__dirname, "../../logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const router = Router();

// Constant Configuration
const VAPI_SECRET = process.env.VAPI_SECRET;
const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 Hour Safety Reaper

// Rate Limiter — prevent DoS on webhook endpoint
const webhookLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per window
    message: { error: "Too many requests, please try again later." }
});
router.use('/webhook', webhookLimiter);

/** @type {Record<string, string>} */
const callStateMap = {};

/** @type {Record<string, string>} - Stores last response per call to detect echo */
const lastResponseMap = {};

/** @type {Record<string, {name: string, email: string}>} - Known entities per call */
const entityMap = {};

/** @type {Record<string, Array<{role: string, content: string}>>} - Full conversation history per call */
const conversationHistoryMap = {};

/** @type {Record<string, NodeJS.Timeout>} - Safety reapers for abandoned sessions */
const sessionReapers = {};

/** @type {Set<string>} - Tracks already-processed toolCallIds */
const processedToolCalls = new Set();

/**
 * cleanUpSession - Ensure no memory leaks when a call ends or is abandoned
 * @param {string} callId 
 */
function cleanUpSession(callId) {
    if (sessionReapers[callId]) {
        clearTimeout(sessionReapers[callId]);
        delete sessionReapers[callId];
    }
    delete callStateMap[callId];
    delete lastResponseMap[callId];
    delete entityMap[callId];
    delete conversationHistoryMap[callId];
    logger.info(`Session cleaned up`, { callId });
}

// Events we acknowledge immediately
const PASSTHROUGH_EVENTS = new Set([
    "assistant.started",
    "assistant.speechStarted",
    "speech-update",
    "status-update",
    "transcript",
    "conversation-update",
    "hang",
    "transfer-update",
    "user-interrupted",
]);

router.post('/webhook', async (req, res) => {
    // SECURITY: Webhook Secret Verification
    const incomingSecret = req.headers['x-vapi-secret'];
    if (VAPI_SECRET && incomingSecret !== VAPI_SECRET) {
        logger.error("Unauthorized request — VAPI_SECRET mismatch", { incomingSecret });
        // If testing locally via Web SDK and Vapi Dashboard hasn't been configured with the secret, 
        // the incoming secret will be empty. We will allow this to pass with a warning.
        if (!incomingSecret) {
            logger.warn("Bypassing strict VAPI_SECRET check because incoming secret is empty. (Ensure you add it in the Vapi Dashboard for production!)");
        } else {
            return res.status(401).json({ error: "Unauthorized" });
        }
    }

    const body = req.body || {};
    const message = body.message || {};
    const messageType = message.type || body.type || "";

    const callId = body.call?.id || message.call?.id || body.callId || "default";

    // Step 1: passthrough events
    if (PASSTHROUGH_EVENTS.has(messageType)) {
        return res.status(200).json({ received: true });
    }

    // Initialize or Reset Safety Reaper for this call
    if (callId !== "default") {
        if (sessionReapers[callId]) clearTimeout(sessionReapers[callId]);
        sessionReapers[callId] = setTimeout(() => cleanUpSession(callId), SESSION_EXPIRY_MS);
    }

    // Step 3: end-of-call cleanup
    if (messageType === "end-of-call-report") {
        console.log(`[DEBUG] Received End of Call Report for callId: ${callId}`);
        try {
            logger.info("Processing end-of-call-report", { callId });

            const history = conversationHistoryMap[callId] || [];
            const historyTranscript = history
                .map(t => `${t.role === "user" ? "User" : "Alex"}: ${t.content}`)
                .join("\n");

            const payload = parseEndOfCallReport(body, historyTranscript);
            const transcript = message.artifact?.transcript || historyTranscript || ""; // Defined safely

            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            let extractedName = "Unknown";
            let extractedEmail = "Unknown";
            let summary = payload.summary || "Discussion regarding legacy system modernization.";

            // Refined extraction and summary via Groq
            try {
                // 1. EXTRACTION PASS: Get clean JSON data
                const extraction = await groq.chat.completions.create({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: "Extract the name and email from the transcript. Return ONLY JSON: { \"name\": \"...\", \"email\": \"...\" }. Use 'Unknown' if missing." },
                        { role: "user", content: transcript }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.1
                });

                const parsed = JSON.parse(extraction.choices[0].message.content);
                extractedName = parsed.name || "Unknown";
                extractedEmail = parsed.email || "Unknown";

                if (extractedName !== "Unknown") payload.customer.name = extractedName;
                if (extractedEmail !== "Unknown") payload.customer.email = extractedEmail;

                // 2. SUMMARY PASS: Write the 1-sentence recap
                // 2. SUMMARY PASS: Write the 1-sentence recap
                const summaryGen = await groq.chat.completions.create({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        {
                            role: "system",
                            content: "Extract the user's core technical problem from the transcript in exactly ONE concise sentence. Start with an action verb (e.g., 'Modernizing a 30-year-old COBOL system'). DO NOT include greetings, sign-offs, or conversational filler like 'Here is the summary'. Return ONLY the raw sentence."
                        },
                        { role: "user", content: transcript }
                    ],
                    temperature: 0.1, // Turn down creativity so it stops "guessing"
                    max_tokens: 40    // Physically block it from writing a long email
                });
                summary = summaryGen.choices[0].message.content.trim();

            } catch (llmErr) {
                logger.warn("Groq entity/summary extraction failed, falling back", { callId, error: llmErr.message });
            }

            // 3. DISPATCH + FILE LOG — no email
            payload.customer.name = extractedName !== "Unknown" ? extractedName : payload.customer.name;
            payload.customer.email = extractedEmail !== "Unknown" ? extractedEmail : payload.customer.email;

            // Write raw call log to disk — persists across server restarts
            const callLog = {
                callId,
                timestamp: new Date().toISOString(),
                customer: payload.customer,
                intent: payload.intent,
                summary,
                redlineFlagged: payload.redlineFlagged,
                transcript: historyTranscript,
            };
            try {
                const logPath = path.join(LOGS_DIR, `${callId}.json`);
                fs.writeFileSync(logPath, JSON.stringify(callLog, null, 2), "utf-8");
                console.log(`[LOG] Call log saved → logs/${callId}.json`);
            } catch (writeErr) {
                logger.warn("Failed to write call log file", { callId, error: writeErr.message });
            }

            dispatchLead(payload);
            pushEvent(callId, "CALL_ENDED", {
                lead: payload,
                summary,
            });
        } catch (err) {
            logger.error("Lead extraction failed", { callId, error: err.message });
        } finally {
            cleanUpSession(callId);
        }
        return res.status(200).json({ received: true });
    }

    // Step 4: assistant-request — SPEAK FIRST logic
    if (messageType === "assistant-request") {
        const firstMsg = "Welcome to Dino Software. I'm Alex. Are you looking to modernize a legacy system today?";

        logger.info("Assistant request received — returning firstMessage", { callId });
        pushEvent(callId, "CALL_STARTED", {
            ts: Date.now(),
            firstMessage: "Welcome to Dino Software. I'm Alex..." // Dashboard sync
        });

        return res.status(200).json({
            assistant: { firstMessage: firstMsg }
        });
    }

    // Step 5: tool-calls — The "Brain"
    if (messageType === "tool-calls") {
        try {
            let transcript = "";
            const rawArgs = message.toolCallList?.[0]?.function?.arguments ||
                message.toolWithToolCallList?.[0]?.toolCall?.function?.arguments;

            if (typeof rawArgs === "string") {
                const parsedArgs = JSON.parse(rawArgs);
                transcript = parsedArgs.Transcript || parsedArgs.transcript || parsedArgs.message || parsedArgs.input || "";
            } else if (rawArgs) {
                transcript = rawArgs.Transcript || rawArgs.transcript || rawArgs.message || rawArgs.input || "";
            }

            const toolCallId = message.toolCallList?.[0]?.id ||
                message.toolWithToolCallList?.[0]?.toolCall?.id || "unknown";

            // Guard 1: Deduplicate
            if (processedToolCalls.has(toolCallId)) {
                logger.warn("Duplicate tool-call detected", { callId, toolCallId });
                return res.status(200).json({ results: [{ toolCallId, result: "" }] });
            }
            processedToolCalls.add(toolCallId);
            if (processedToolCalls.size > 500) processedToolCalls.clear();

            // Guard 2: Empty transcript
            if (!transcript.trim()) {
                logger.info("Empty transcript — asking to repeat", { callId });
                return res.status(200).json({
                    results: [{ toolCallId, result: "I didn't quite catch that. Could you repeat it?" }]
                });
            }

            // Guard 3: Strict echo deduplication
            const lastResponse = lastResponseMap[callId] || "";
            const normalizedTranscript = transcript.toLowerCase().trim();
            const normalizedLast = lastResponse.toLowerCase().trim();
            if (normalizedLast && (
                normalizedLast === normalizedTranscript ||
                normalizedLast.includes(normalizedTranscript) && normalizedTranscript.length > 20
            )) {
                logger.warn("Echo/duplicate detected — skipping routing", { callId, transcript });
                return res.status(200).json({ results: [{ toolCallId, result: "" }] });
            }

            // Extract and cache any entities found in this transcript
            if (!entityMap[callId]) entityMap[callId] = { name: "Unknown", email: "" };
            const { extractName, extractEmail } = require("../services/leadParser");
            const detectedName = extractName(transcript);
            const detectedEmail = extractEmail(transcript);
            if (detectedName !== "Unknown") entityMap[callId].name = detectedName;
            if (detectedEmail) entityMap[callId].email = detectedEmail;

            // Append user turn to conversation history
            if (!conversationHistoryMap[callId]) conversationHistoryMap[callId] = [];
            conversationHistoryMap[callId].push({ role: "user", content: transcript });

            // Route through brain, passing both entity context and conversation history
            const currentState = callStateMap[callId] || CallStateMap.GREETING;
            logger.info("Routing through state machine", { callId, fromState: currentState, transcript });

            const result = await routingHandler(transcript, currentState, entityMap[callId], conversationHistoryMap[callId]);

            callStateMap[callId] = result.nextState;
            lastResponseMap[callId] = result.content;

            // Append bot response to conversation history for full context on next turn
            conversationHistoryMap[callId].push({ role: "bot", content: result.content });

            // Cap history at 20 turns (10 exchanges) to stay within token budgets
            if (conversationHistoryMap[callId].length > 20) {
                conversationHistoryMap[callId] = conversationHistoryMap[callId].slice(-20);
            }

            pushEvent(callId, result.redlined ? "REDLINE" : "TURN", {
                transcript,
                response: result.content,
                fromState: currentState,
                toState: result.nextState,
                redlined: result.redlined,
            });

            pushEvent(callId, "BOT_RESPONSE", {
                transcript: result.content,
                state: result.nextState,
            });

            logger.info("Brain Response complete", {
                callId,
                nextState: result.nextState,
                redlined: result.redlined
            });

            return res.status(200).json({
                results: [{ toolCallId, result: result.content }]
            });

        } catch (err) {
            logger.error("Brain Routing Critical Failure", { callId, error: err.stack });
            return res.status(200).json({
                results: [{
                    toolCallId: "fallback",
                    result: "I'm having a bit of trouble processing that. Give me just a second?"
                }]
            });
        }
    }

    return res.status(200).json({ received: true });
});

module.exports = router;