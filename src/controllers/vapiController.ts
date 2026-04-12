"use strict";

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { handleRouting: routingHandler } = require("../state-machine/router");
const { CallState: CallStateMap } = require("../types");
const { parseEndOfCallReport } = require("../services/leadParser");
const { dispatchLead } = require("../services/crmMock");
const { pushEvent } = require("../ws/broadcaster");
const logger = require("../utils/logger");

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
        return res.status(401).json({ error: "Unauthorized" });
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
        try {
            logger.info("Processing end-of-call-report", { callId });
            const payload = parseEndOfCallReport(body);
            dispatchLead(payload);
            pushEvent(callId, "CALL_ENDED", {
                lead: payload,
                summary: payload.summary,
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

            // Guard 3: Strict echo deduplication — drop if transcript == last bot response
            const lastResponse = lastResponseMap[callId] || "";
            const normalizedTranscript = transcript.toLowerCase().trim();
            const normalizedLast = lastResponse.toLowerCase().trim();
            // Exact match OR transcript is fully contained within the bot's last response (echo/replay)
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

            // Route through brain, passing the entity context
            const currentState = callStateMap[callId] || CallStateMap.GREETING;
            logger.info("Routing through state machine", { callId, fromState: currentState, transcript });
            
            const result = await routingHandler(transcript, currentState, entityMap[callId]);
            
            callStateMap[callId] = result.nextState;
            lastResponseMap[callId] = result.content;

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