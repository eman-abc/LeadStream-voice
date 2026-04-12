"use strict";

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const Groq = require("groq-sdk");

// Services & Utils
const { handleRouting: routingHandler } = require("../state-machine/router");
const { CallState: CallStateMap } = require("../types");
const { parseEndOfCallReport, extractName, extractEmail } = require("../services/leadParser");
const { dispatchLead } = require("../services/crmMock");
const { sendFollowUpEmail } = require("../services/mailService");
const { pushEvent } = require("../ws/broadcaster");
const logger = require("../utils/logger");

const router = Router();

// Constant Configuration
const VAPI_SECRET = process.env.VAPI_SECRET;
const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 Hour Safety Reaper

// Initialize LLM once globally
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Rate Limiter — prevent DoS on webhook endpoint
const webhookLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per window
    message: { error: "Too many requests, please try again later." }
});
router.use('/webhook', webhookLimiter);

// --- In-Memory State Managers ---
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
 * Ensures no memory leaks when a call ends or is abandoned
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
    logger.info("Session cleaned up", { callId });
}

// Events we acknowledge immediately without processing logic
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
        return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};
    const message = body.message || {};
    const messageType = message.type || body.type || "";
    const callId = body.call?.id || message.call?.id || body.callId || "default";

    // Step 1: Passthrough events
    if (PASSTHROUGH_EVENTS.has(messageType)) {
        return res.status(200).json({ received: true });
    }

    // Step 2: Initialize or Reset Safety Reaper for this call
    if (callId !== "default") {
        if (sessionReapers[callId]) clearTimeout(sessionReapers[callId]);
        sessionReapers[callId] = setTimeout(() => cleanUpSession(callId), SESSION_EXPIRY_MS);
    }

    // Step 3: End-of-call cleanup & Lead Processing
    if (messageType === "end-of-call-report") {
        logger.info("Processing end-of-call-report", { callId });

        try {
            // Build transcript with speaker labels for better LLM context
            const history = conversationHistoryMap[callId] || [];
            const historyTranscript = history
                .map(t => `${t.role === "user" ? "User" : "Alex"}: ${t.content}`)
                .join("\n") || message.artifact?.transcript || "";

            const payload = parseEndOfCallReport(body, historyTranscript);

            // --- LLM SHADOW PASS (Extraction & Summary) ---
            try {
                // 1. EXTRACTION PASS: Get clean JSON data for name and email
                const extraction = await groq.chat.completions.create({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: "Extract the caller's name and email from the transcript. Return ONLY JSON: { \"name\": \"...\", \"email\": \"...\" }. Use 'Unknown' if missing." },
                        { role: "user", content: historyTranscript }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.1
                });

                const { name, email } = JSON.parse(extraction.choices[0].message.content);
                if (name && name !== "Unknown") payload.customer.name = name;
                if (email && email !== "Unknown") payload.customer.email = email;

                // 2. SUMMARY PASS: Write the 1-sentence recap
                const summaryGen = await groq.chat.completions.create({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: "Write a 1-sentence summary of the user's technical problem for a follow-up email. Be professional." },
                        { role: "user", content: historyTranscript }
                    ],
                    temperature: 0.3
                });

                const summary = summaryGen.choices[0].message.content.trim();
                payload.summary = summary; // Attach smart summary to the CRM payload

                // 3. VALIDATION & DISPATCH
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (email !== 'Unknown' && emailRegex.test(email)) {
                    await sendFollowUpEmail(email, payload.customer.name, summary);
                    logger.info(`[MAIL] Success: Personalized follow-up sent to ${email}`);

                    // Push specific email success event to dashboard
                    pushEvent(callId, 'LEAD_CAPTURED', { name, email, summary, status: 'Email Sent' });
                }
            } catch (llmErr) {
                logger.warn("Groq post-call processing failed, falling back to basic payload", { callId, error: llmErr.message });
            }

            // Push final data to CRM and WebSocket
            dispatchLead(payload);
            pushEvent(callId, "CALL_ENDED", {
                lead: payload,
                summary: payload.summary,
            });

        } catch (err) {
            logger.error("End-of-call extraction failed", { callId, error: err.message });
        } finally {
            cleanUpSession(callId);
        }
        return res.status(200).json({ received: true });
    }

    // Step 4: Assistant-request — SPEAK FIRST logic
    if (messageType === "assistant-request") {
        const firstMsg = "Welcome to Dino Software. I'm Alex. Are you looking to modernize a legacy system today?";
        logger.info("Assistant request received — returning firstMessage", { callId });

        pushEvent(callId, "CALL_STARTED", {
            ts: Date.now(),
            firstMessage: firstMsg
        });

        return res.status(200).json({
            assistant: { firstMessage: firstMsg }
        });
    }

    // Step 5: Tool-calls — The "Brain"
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
                (normalizedLast.includes(normalizedTranscript) && normalizedTranscript.length > 20)
            )) {
                logger.warn("Echo/duplicate detected — skipping routing", { callId, transcript });
                return res.status(200).json({ results: [{ toolCallId, result: "" }] });
            }

            // Extract and cache entities on the fly
            if (!entityMap[callId]) entityMap[callId] = { name: "Unknown", email: "" };

            const detectedName = extractName(transcript);
            const detectedEmail = extractEmail(transcript);
            if (detectedName !== "Unknown") entityMap[callId].name = detectedName;
            if (detectedEmail) entityMap[callId].email = detectedEmail;

            // Append user turn to conversation history
            if (!conversationHistoryMap[callId]) conversationHistoryMap[callId] = [];
            conversationHistoryMap[callId].push({ role: "user", content: transcript });

            // Route through state machine
            const currentState = callStateMap[callId] || CallStateMap.GREETING;
            logger.info("Routing through state machine", { callId, fromState: currentState, transcript });

            const result = await routingHandler(transcript, currentState, entityMap[callId], conversationHistoryMap[callId]);

            // Update State & History Cache
            callStateMap[callId] = result.nextState;
            lastResponseMap[callId] = result.content;
            conversationHistoryMap[callId].push({ role: "bot", content: result.content });

            // Cap history at 20 turns (10 exchanges) to prevent token overflow
            if (conversationHistoryMap[callId].length > 20) {
                conversationHistoryMap[callId] = conversationHistoryMap[callId].slice(-20);
            }

            // Broadcast events to frontend
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