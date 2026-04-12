"use strict";

const { Router } = require('express');
const { handleRouting: routingHandler } = require("../state-machine/router");
const { CallState: CallStateMap } = require("../types");
const { parseEndOfCallReport } = require("../services/leadParser");
const { dispatchLead } = require("../services/crmMock");
const { pushEvent } = require("../ws/broadcaster");

const router = Router();

/** @type {Record<string, string>} */
const callStateMap = {};

/** @type {Record<string, string>} - Stores last response per call to detect echo */
const lastResponseMap = {};

/** @type {Set<string>} - Tracks already-processed toolCallIds to prevent duplicate routing */
const processedToolCalls = new Set();

// Events we acknowledge immediately without any routing logic
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
    const body = req.body || {};
    const message = body.message || {};
    const messageType = message.type || body.type || "";

    // Always log the event type so we can see what's arriving
    console.log(`[WEBHOOK] ${messageType}`);

    // Step 1: passthrough events — respond in <5ms, never touch Groq
    if (PASSTHROUGH_EVENTS.has(messageType)) {
        return res.status(200).json({ received: true });
    }

    // Step 2: extract callId
    const callId =
        body.call?.id ||
        message.call?.id ||
        body.callId ||
        "default";

    // Step 3: end-of-call cleanup — no routing needed
    if (messageType === "end-of-call-report") {
        console.log(`[CALL_END] Processing end-of-call for callId: ${callId}`);
        
        try {
            const payload = parseEndOfCallReport(body);
            dispatchLead(payload);
            pushEvent(callId, "CALL_ENDED", {
                lead: payload,
                summary: payload.summary,
            });
        } catch (err) {
            console.error("[CALL_END] Lead extraction failed:", err.message);
        }
        
        delete callStateMap[callId];
        delete lastResponseMap[callId]; // kept to prevent memory leak although omitted in instructions
        console.log(`[CALL_END] State map cleared for callId: ${callId}`);
        return res.status(200).json({ received: true });
    }

    // Step 4: assistant-request — return first message, no Groq
    if (messageType === "assistant-request") {
        pushEvent(callId, "CALL_STARTED", {
            ts: Date.now(),
            firstMessage: "Welcome to Dino Software. I'm Riley..."
        });
        
        return res.status(200).json({
            assistant: {
                firstMessage: "Welcome to Dino Software. I'm Evolve. Are you looking to modernize a legacy system today?"
            }
        });
    }

    // Step 5: tool-calls — the ONLY event that routes through the brain
    if (messageType === "tool-calls") {
        let transcript = "";

        // Grab the raw arguments payload
        const rawArgs =
            message.toolCallList?.[0]?.function?.arguments ||
            message.toolWithToolCallList?.[0]?.toolCall?.function?.arguments;

        // Vapi sends arguments as a JSON string — parse it
        if (typeof rawArgs === "string") {
            try {
                const parsedArgs = JSON.parse(rawArgs);
                transcript = parsedArgs.Transcript || parsedArgs.transcript || parsedArgs.message || parsedArgs.input || "";
            } catch (e) {
                console.error("[ERROR] Failed to parse Vapi tool arguments string.");
            }
        } else if (rawArgs) {
            transcript = rawArgs.Transcript || rawArgs.transcript || rawArgs.message || rawArgs.input || "";
        }

        const toolCallId =
            message.toolCallList?.[0]?.id ||
            message.toolWithToolCallList?.[0]?.toolCall?.id ||
            "unknown";

        console.log(`[TOOL_CALL] Extracted Transcript: "${transcript}"`);

        // Guard 1: Deduplicate — skip if we already processed this exact tool call
        if (processedToolCalls.has(toolCallId)) {
            console.log(`[DUPLICATE] Skipping already-processed toolCallId: ${toolCallId}`);
            return res.status(200).json({
                results: [{ toolCallId, result: "" }]
            });
        }
        processedToolCalls.add(toolCallId);
        // Prevent the Set from growing forever on long-running servers
        if (processedToolCalls.size > 500) processedToolCalls.clear();

        // Guard 2: Empty transcript — ask to repeat
        if (!transcript.trim()) {
            return res.status(200).json({
                results: [{
                    toolCallId,
                    result: "I didn't quite catch that. Could you repeat it?"
                }]
            });
        }

        // Guard 3: Echo detection — if transcript matches our last response, it's the assistant's own voice
        const lastResponse = lastResponseMap[callId] || "";
        const normalizedTranscript = transcript.toLowerCase().trim();
        const normalizedLast = lastResponse.toLowerCase().trim();
        if (normalizedLast && normalizedLast.startsWith(normalizedTranscript.slice(0, 40))) {
            console.log(`[ECHO_DETECTED] Transcript matches last assistant response — skipping`);
            return res.status(200).json({
                results: [{ toolCallId, result: "" }]
            });
        }

        // Route the real transcript through the brain
        const currentState = callStateMap[callId] || CallStateMap.GREETING;
        const result = await routingHandler(transcript, currentState);
        callStateMap[callId] = result.nextState;
        lastResponseMap[callId] = result.content;

        pushEvent(callId, result.redlined ? "REDLINE" : "TURN", {
            transcript,
            response: result.content,
            fromState: currentState,
            toState: result.nextState,
            redlined: result.redlined,
        });

        console.log(`[STATE]    ${currentState} → ${result.nextState}`);
        console.log(`[REDLINED] ${result.redlined}`);
        console.log(`[RESPONSE] "${result.content}"`);

        return res.status(200).json({
            results: [{
                toolCallId,
                result: result.content
            }]
        });
    }

    // Step 6: anything else we haven't handled — fast 200, never Groq
    console.log(`[UNHANDLED] ${messageType} — returning 200`);
    return res.status(200).json({ received: true });
});

module.exports = router;