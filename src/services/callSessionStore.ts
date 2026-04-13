"use strict";

const crypto = require("crypto");
const { createClient } = require("redis");
const logger = require("../utils/logger");

const SESSION_TTL_SECONDS = 2 * 60 * 60;
const MAX_HISTORY_LENGTH = 20;
const WORKER_LOCK_TTL_SECONDS = 120;
const PENDING_CALLS_KEY = "async-llm:pending-calls";

function buildCallKey(callId, suffix) {
    return `call:${callId}:${suffix}`;
}

function getStateKey(callId) {
    return buildCallKey(callId, "state");
}

function getEntitiesKey(callId) {
    return buildCallKey(callId, "entities");
}

function getHistoryKey(callId) {
    return buildCallKey(callId, "history");
}

function getLastResponseKey(callId) {
    return buildCallKey(callId, "last-response");
}

function getProcessedToolCallKey(callId, toolCallId) {
    return buildCallKey(callId, `tool-call:${toolCallId}:processed`);
}

function getResponseQueueKey(callId) {
    return buildCallKey(callId, "response-queue");
}

function getControlUrlKey(callId) {
    return buildCallKey(callId, "control-url");
}

function getWorkerLockKey(callId) {
    return buildCallKey(callId, "response-worker-lock");
}

function defaultEntities() {
    return { name: "Unknown", email: "" };
}

function safeJsonParse(raw, fallback) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (error) {
        return fallback;
    }
}

function createMemoryStore() {
    const state = new Map();
    const entities = new Map();
    const history = new Map();
    const lastResponse = new Map();
    const processedToolCalls = new Set();
    const responseQueues = new Map();
    const controlUrls = new Map();
    const pendingCalls = new Set();
    const workerLocks = new Map();

    return {
        async getCallState(callId) {
            return state.get(callId) || null;
        },
        async setCallState(callId, nextState) {
            state.set(callId, nextState);
        },
        async getEntities(callId) {
            return entities.get(callId) || defaultEntities();
        },
        async setEntities(callId, nextEntities) {
            entities.set(callId, nextEntities);
        },
        async getHistory(callId) {
            return [...(history.get(callId) || [])];
        },
        async appendHistory(callId, turn) {
            const nextHistory = [...(history.get(callId) || []), turn].slice(-MAX_HISTORY_LENGTH);
            history.set(callId, nextHistory);
            return nextHistory;
        },
        async getLastResponse(callId) {
            return lastResponse.get(callId) || "";
        },
        async setLastResponse(callId, response) {
            lastResponse.set(callId, response);
        },
        async markToolCallProcessed(callId, toolCallId) {
            const key = `${callId}:${toolCallId}`;
            if (processedToolCalls.has(key)) return false;
            processedToolCalls.add(key);
            return true;
        },
        async enqueueResponseJob(callId, job) {
            const queue = responseQueues.get(callId) || [];
            queue.push(job);
            responseQueues.set(callId, queue);
            pendingCalls.add(callId);
        },
        async prependResponseJob(callId, job) {
            const queue = responseQueues.get(callId) || [];
            queue.unshift(job);
            responseQueues.set(callId, queue);
            pendingCalls.add(callId);
        },
        async dequeueResponseJob(callId) {
            const queue = responseQueues.get(callId) || [];
            const job = queue.shift() || null;
            if (queue.length === 0) {
                responseQueues.delete(callId);
                pendingCalls.delete(callId);
            } else {
                responseQueues.set(callId, queue);
            }
            return job;
        },
        async setControlUrl(callId, controlUrl) {
            if (controlUrl) controlUrls.set(callId, controlUrl);
        },
        async getControlUrl(callId) {
            return controlUrls.get(callId) || "";
        },
        async acquireResponseWorkerLock(callId) {
            if (workerLocks.has(callId)) return null;
            const token = crypto.randomUUID();
            workerLocks.set(callId, token);
            return token;
        },
        async releaseResponseWorkerLock(callId, token) {
            if (workerLocks.get(callId) === token) {
                workerLocks.delete(callId);
            }
        },
        async listPendingCalls() {
            return [...pendingCalls];
        },
        async clearSession(callId) {
            state.delete(callId);
            entities.delete(callId);
            history.delete(callId);
            lastResponse.delete(callId);
            responseQueues.delete(callId);
            controlUrls.delete(callId);
            pendingCalls.delete(callId);
            workerLocks.delete(callId);
        },
    };
}

function createRedisStore(redisUrl) {
    const client = createClient({ url: redisUrl });

    client.on("error", (error) => {
        logger.error("Redis client error", { error: error.message });
    });

    return {
        async connect() {
            if (!client.isOpen) {
                await client.connect();
                logger.info("Redis call session store connected");
            }
        },
        async getCallState(callId) {
            return client.get(getStateKey(callId));
        },
        async setCallState(callId, nextState) {
            await client.set(getStateKey(callId), nextState, { EX: SESSION_TTL_SECONDS });
        },
        async getEntities(callId) {
            const raw = await client.get(getEntitiesKey(callId));
            return safeJsonParse(raw, defaultEntities());
        },
        async setEntities(callId, nextEntities) {
            await client.set(getEntitiesKey(callId), JSON.stringify(nextEntities), { EX: SESSION_TTL_SECONDS });
        },
        async getHistory(callId) {
            const entries = await client.lRange(getHistoryKey(callId), 0, -1);
            return entries.map((entry) => safeJsonParse(entry, null)).filter(Boolean);
        },
        async appendHistory(callId, turn) {
            const historyKey = getHistoryKey(callId);
            await client.multi()
                .rPush(historyKey, JSON.stringify(turn))
                .lTrim(historyKey, -MAX_HISTORY_LENGTH, -1)
                .expire(historyKey, SESSION_TTL_SECONDS)
                .exec();

            return this.getHistory(callId);
        },
        async getLastResponse(callId) {
            return (await client.get(getLastResponseKey(callId))) || "";
        },
        async setLastResponse(callId, response) {
            await client.set(getLastResponseKey(callId), response, { EX: SESSION_TTL_SECONDS });
        },
        async markToolCallProcessed(callId, toolCallId) {
            const result = await client.set(
                getProcessedToolCallKey(callId, toolCallId),
                "1",
                { EX: SESSION_TTL_SECONDS, NX: true }
            );
            return result === "OK";
        },
        async enqueueResponseJob(callId, job) {
            const queueKey = getResponseQueueKey(callId);
            await client.multi()
                .rPush(queueKey, JSON.stringify(job))
                .expire(queueKey, SESSION_TTL_SECONDS)
                .sAdd(PENDING_CALLS_KEY, callId)
                .exec();
        },
        async prependResponseJob(callId, job) {
            const queueKey = getResponseQueueKey(callId);
            await client.multi()
                .lPush(queueKey, JSON.stringify(job))
                .expire(queueKey, SESSION_TTL_SECONDS)
                .sAdd(PENDING_CALLS_KEY, callId)
                .exec();
        },
        async dequeueResponseJob(callId) {
            const queueKey = getResponseQueueKey(callId);
            const raw = await client.lPop(queueKey);
            if (!raw) {
                await client.sRem(PENDING_CALLS_KEY, callId);
                return null;
            }

            const remaining = await client.lLen(queueKey);
            if (remaining === 0) {
                await client.sRem(PENDING_CALLS_KEY, callId);
            } else {
                await client.expire(queueKey, SESSION_TTL_SECONDS);
            }

            return safeJsonParse(raw, null);
        },
        async setControlUrl(callId, controlUrl) {
            if (!controlUrl) return;
            await client.set(getControlUrlKey(callId), controlUrl, { EX: SESSION_TTL_SECONDS });
        },
        async getControlUrl(callId) {
            return (await client.get(getControlUrlKey(callId))) || "";
        },
        async acquireResponseWorkerLock(callId) {
            const token = crypto.randomUUID();
            const result = await client.set(
                getWorkerLockKey(callId),
                token,
                { NX: true, EX: WORKER_LOCK_TTL_SECONDS }
            );
            return result === "OK" ? token : null;
        },
        async releaseResponseWorkerLock(callId, token) {
            const lockKey = getWorkerLockKey(callId);
            const current = await client.get(lockKey);
            if (current === token) {
                await client.del(lockKey);
            }
        },
        async listPendingCalls() {
            return client.sMembers(PENDING_CALLS_KEY);
        },
        async clearSession(callId) {
            await client.multi()
                .del([
                    getStateKey(callId),
                    getEntitiesKey(callId),
                    getHistoryKey(callId),
                    getLastResponseKey(callId),
                    getResponseQueueKey(callId),
                    getControlUrlKey(callId),
                    getWorkerLockKey(callId),
                ])
                .sRem(PENDING_CALLS_KEY, callId)
                .exec();
        },
    };
}

let storePromise = null;

async function getCallSessionStore() {
    if (!storePromise) {
        storePromise = (async () => {
            if (process.env.NODE_ENV === "test") {
                logger.info("Using in-memory call session store for tests");
                return createMemoryStore();
            }

            const redisUrl = process.env.REDIS_URL;
            if (!redisUrl) {
                throw new Error("REDIS_URL is required outside the test environment.");
            }

            const store = createRedisStore(redisUrl);
            await store.connect();
            return store;
        })();
    }

    return storePromise;
}

async function initCallSessionStore() {
    await getCallSessionStore();
}

module.exports = {
    SESSION_TTL_SECONDS,
    MAX_HISTORY_LENGTH,
    getCallSessionStore,
    initCallSessionStore,
};
