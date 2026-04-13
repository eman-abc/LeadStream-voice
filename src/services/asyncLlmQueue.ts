"use strict";

const { handleRouting: routingHandler } = require("../state-machine/router");
const { CallState: CallStateMap } = require("../types");
const { extractName, extractEmail } = require("./leadParser");
const { getCallSessionStore } = require("./callSessionStore");
const { injectAssistantMessage } = require("./vapiLiveControl");
const { pushEvent } = require("../ws/broadcaster");
const logger = require("../utils/logger");

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function scheduleRetry(callId, attempt) {
    const delay = RETRY_BASE_DELAY_MS * attempt;
    const timer = setTimeout(() => {
        void processQueuedResponses(callId);
    }, delay);

    if (typeof timer.unref === "function") {
        timer.unref();
    }
}

function extractControlUrl(call) {
    return call?.monitor?.controlUrl || "";
}

async function queueLlmTurn(job) {
    const sessionStore = await getCallSessionStore();

    if (job.controlUrl) {
        await sessionStore.setControlUrl(job.callId, job.controlUrl);
    }

    await sessionStore.enqueueResponseJob(job.callId, {
        ...job,
        attempts: job.attempts || 0,
        queuedAt: job.queuedAt || Date.now(),
    });

    pushEvent(job.callId, "TURN_QUEUED", {
        transcript: job.transcript,
        toolCallId: job.toolCallId,
    });

    void processQueuedResponses(job.callId);
}

async function processQueuedResponses(callId) {
    const sessionStore = await getCallSessionStore();
    const lockToken = await sessionStore.acquireResponseWorkerLock(callId);
    if (!lockToken) return;

    try {
        while (true) {
            const job = await sessionStore.dequeueResponseJob(callId);
            if (!job) return;

            try {
                await processSingleJob(job);
            } catch (error) {
                const attempts = (job.attempts || 0) + 1;
                logger.error("Async LLM job failed", {
                    callId,
                    toolCallId: job.toolCallId,
                    attempts,
                    error: error.message,
                });

                if (attempts < MAX_RETRY_ATTEMPTS) {
                    await sessionStore.prependResponseJob(callId, {
                        ...job,
                        attempts,
                        lastError: error.message,
                    });
                    scheduleRetry(callId, attempts);
                } else {
                    pushEvent(callId, "BOT_RESPONSE_FAILED", {
                        toolCallId: job.toolCallId,
                        error: error.message,
                    });
                }

                return;
            }
        }
    } finally {
        await sessionStore.releaseResponseWorkerLock(callId, lockToken);
    }
}

async function processSingleJob(job) {
    const sessionStore = await getCallSessionStore();
    const transcript = (job.transcript || "").trim();

    if (!transcript) {
        const repeatPrompt = "I didn't quite catch that. Could you repeat it?";
        await injectAssistantMessage(job.callId, job.controlUrl || await sessionStore.getControlUrl(job.callId), repeatPrompt);
        pushEvent(job.callId, "BOT_RESPONSE", {
            transcript: repeatPrompt,
            state: await sessionStore.getCallState(job.callId) || CallStateMap.GREETING,
        });
        return;
    }

    const [lastResponse, currentState, entities, cachedControlUrl] = await Promise.all([
        sessionStore.getLastResponse(job.callId),
        sessionStore.getCallState(job.callId),
        sessionStore.getEntities(job.callId),
        sessionStore.getControlUrl(job.callId),
    ]);

    const normalizedTranscript = transcript.toLowerCase();
    const normalizedLast = lastResponse.toLowerCase().trim();
    if (normalizedLast && (
        normalizedLast === normalizedTranscript ||
        (normalizedLast.includes(normalizedTranscript) && normalizedTranscript.length > 20)
    )) {
        logger.warn("Async queue skipped echoed transcript", { callId: job.callId, transcript });
        return;
    }

    const detectedName = extractName(transcript);
    const detectedEmail = extractEmail(transcript);
    if (detectedName !== "Unknown") entities.name = detectedName;
    if (detectedEmail) entities.email = detectedEmail;
    await sessionStore.setEntities(job.callId, entities);

    const conversationHistory = await sessionStore.appendHistory(job.callId, { role: "user", content: transcript });
    const fromState = currentState || CallStateMap.GREETING;
    logger.info("Routing through async state machine", { callId: job.callId, fromState, transcript });

    const result = await routingHandler(transcript, fromState, entities, conversationHistory);

    await Promise.all([
        sessionStore.setCallState(job.callId, result.nextState),
        sessionStore.setLastResponse(job.callId, result.content),
        sessionStore.appendHistory(job.callId, { role: "bot", content: result.content }),
    ]);

    pushEvent(job.callId, result.redlined ? "REDLINE" : "TURN", {
        transcript,
        response: result.content,
        fromState,
        toState: result.nextState,
        redlined: result.redlined,
    });

    pushEvent(job.callId, "BOT_RESPONSE", {
        transcript: result.content,
        state: result.nextState,
    });

    await injectAssistantMessage(job.callId, job.controlUrl || cachedControlUrl, result.content);
    pushEvent(job.callId, "BOT_RESPONSE_INJECTED", {
        transcript: result.content,
        toolCallId: job.toolCallId,
    });

    logger.info("Async LLM response injected", {
        callId: job.callId,
        nextState: result.nextState,
        redlined: result.redlined,
    });
}

async function initAsyncLlmQueue() {
    const sessionStore = await getCallSessionStore();
    const pendingCalls = await sessionStore.listPendingCalls();
    pendingCalls.forEach((callId) => {
        void processQueuedResponses(callId);
    });
}

module.exports = {
    extractControlUrl,
    initAsyncLlmQueue,
    processQueuedResponses,
    queueLlmTurn,
};
