"use strict";

const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const { CallState: CallStateMap } = require("../types");
const { parseEndOfCallReport } = require("../services/leadParser");
const { dispatchLead } = require("../services/crmMock");
const { extractControlUrl, queueLlmTurn } = require("../services/asyncLlmQueue");
const { getCallSessionStore } = require("../services/callSessionStore");
const { pushEvent } = require("../ws/broadcaster");
const logger = require("../utils/logger");

const LOGS_DIR = path.join(__dirname, "../../logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const router = Router();
const VAPI_SECRET = process.env.VAPI_SECRET;

const webhookLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests, please try again later." },
});
router.use("/webhook", webhookLimiter);

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

async function cleanUpSession(callId) {
    const sessionStore = await getCallSessionStore();
    await sessionStore.clearSession(callId);
    logger.info("Session cleaned up", { callId });
}

function getToolTranscript(message) {
    const rawArgs = message.toolCallList?.[0]?.function?.arguments ||
        message.toolWithToolCallList?.[0]?.toolCall?.function?.arguments;

    if (typeof rawArgs === "string") {
        const parsedArgs = JSON.parse(rawArgs);
        return parsedArgs.Transcript || parsedArgs.transcript || parsedArgs.message || parsedArgs.input || "";
    }

    if (rawArgs) {
        return rawArgs.Transcript || rawArgs.transcript || rawArgs.message || rawArgs.input || "";
    }

    return "";
}

function getToolCallId(message) {
    return message.toolCallList?.[0]?.id ||
        message.toolWithToolCallList?.[0]?.toolCall?.id ||
        "unknown";
}

router.post("/webhook", async (req, res) => {
    const incomingSecret = req.headers["x-vapi-secret"];
    if (VAPI_SECRET && incomingSecret !== VAPI_SECRET) {
        logger.error("Unauthorized request - VAPI_SECRET mismatch", { incomingSecret });
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
    const sessionStore = await getCallSessionStore();
    const controlUrl = extractControlUrl(message.call || body.call);

    if (controlUrl) {
        await sessionStore.setControlUrl(callId, controlUrl);
    }

    if (PASSTHROUGH_EVENTS.has(messageType)) {
        return res.status(200).json({ received: true });
    }

    if (messageType === "end-of-call-report") {
        console.log(`[DEBUG] Received End of Call Report for callId: ${callId}`);
        try {
            logger.info("Processing end-of-call-report", { callId });

            const history = await sessionStore.getHistory(callId);
            const historyTranscript = history
                .map((turn) => `${turn.role === "user" ? "User" : "Alex"}: ${turn.content}`)
                .join("\n");

            const payload = parseEndOfCallReport(body, historyTranscript);
            const transcript = message.artifact?.transcript || historyTranscript || "";

            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            let extractedName = "Unknown";
            let extractedEmail = "Unknown";
            let summary = payload.summary || "Discussion regarding legacy system modernization.";

            try {
                const extraction = await groq.chat.completions.create({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: "Extract the name and email from the transcript. Return ONLY JSON: { \"name\": \"...\", \"email\": \"...\" }. Use 'Unknown' if missing." },
                        { role: "user", content: transcript },
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.1,
                });

                const parsed = JSON.parse(extraction.choices[0].message.content);
                extractedName = parsed.name || "Unknown";
                extractedEmail = parsed.email || "Unknown";

                if (extractedName !== "Unknown") payload.customer.name = extractedName;
                if (extractedEmail !== "Unknown") payload.customer.email = extractedEmail;

                const summaryGen = await groq.chat.completions.create({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        {
                            role: "system",
                            content: "Extract the user's core technical problem from the transcript in exactly ONE concise sentence. Start with an action verb (e.g., 'Modernizing a 30-year-old COBOL system'). DO NOT include greetings, sign-offs, or conversational filler like 'Here is the summary'. Return ONLY the raw sentence.",
                        },
                        { role: "user", content: transcript },
                    ],
                    temperature: 0.1,
                    max_tokens: 40,
                });
                summary = summaryGen.choices[0].message.content.trim();
            } catch (llmErr) {
                logger.warn("Groq entity/summary extraction failed, falling back", { callId, error: llmErr.message });
            }

            payload.customer.name = extractedName !== "Unknown" ? extractedName : payload.customer.name;
            payload.customer.email = extractedEmail !== "Unknown" ? extractedEmail : payload.customer.email;

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
                await fs.promises.writeFile(logPath, JSON.stringify(callLog, null, 2), "utf-8");
                console.log(`[LOG] Call log saved -> logs/${callId}.json`);
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
            await cleanUpSession(callId);
        }

        return res.status(200).json({ received: true });
    }

    if (messageType === "assistant-request") {
        const firstMsg = "Welcome to Dino Software. I'm Alex. Are you looking to modernize a legacy system today?";

        await sessionStore.setCallState(callId, CallStateMap.GREETING);
        logger.info("Assistant request received - returning firstMessage", { callId });
        pushEvent(callId, "CALL_STARTED", {
            ts: Date.now(),
            firstMessage: "Welcome to Dino Software. I'm Alex...",
        });

        return res.status(200).json({
            assistant: { firstMessage: firstMsg },
        });
    }

    if (messageType === "tool-calls") {
        try {
            const transcript = getToolTranscript(message);
            const toolCallId = getToolCallId(message);
            const acceptedToolCall = await sessionStore.markToolCallProcessed(callId, toolCallId);

            if (!acceptedToolCall) {
                logger.warn("Duplicate tool-call detected", { callId, toolCallId });
                return res.status(202).json({
                    received: true,
                    queued: false,
                    duplicate: true,
                    results: [{ toolCallId, result: "" }],
                });
            }

            await queueLlmTurn({
                callId,
                toolCallId,
                transcript,
                controlUrl,
            });

            return res.status(202).json({
                received: true,
                queued: true,
                results: [{ toolCallId, result: "" }],
            });
        } catch (err) {
            logger.error("Async queueing failure", { callId, error: err.stack });
            return res.status(200).json({
                results: [{
                    toolCallId: "fallback",
                    result: "I'm having a bit of trouble processing that. Give me just a second?",
                }],
            });
        }
    }

    return res.status(200).json({ received: true });
});

module.exports = router;
