"use strict";

const { createClient } = require("redis");
const logger = require("../utils/logger");

const SESSION_TTL_SECONDS = 2 * 60 * 60;
const MAX_HISTORY_LENGTH = 20;

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
        async clearSession(callId) {
            state.delete(callId);
            entities.delete(callId);
            history.delete(callId);
            lastResponse.delete(callId);
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
        async clearSession(callId) {
            await client.del([
                getStateKey(callId),
                getEntitiesKey(callId),
                getHistoryKey(callId),
                getLastResponseKey(callId),
            ]);
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
