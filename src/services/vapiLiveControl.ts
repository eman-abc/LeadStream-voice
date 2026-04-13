"use strict";

const logger = require("../utils/logger");

const VAPI_API_BASE_URL = process.env.VAPI_API_BASE_URL || "https://api.vapi.ai";

async function getCallDetails(callId) {
    const apiKey = process.env.VAPI_API_KEY;
    if (!apiKey) return null;

    const response = await fetch(`${VAPI_API_BASE_URL}/call/${callId}`, {
        method: "GET",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`Vapi get call failed with ${response.status}`);
    }

    const raw = await response.text();
    return JSON.parse(raw);
}

async function resolveControlUrl(callId, cachedControlUrl) {
    if (cachedControlUrl) return cachedControlUrl;

    const call = await getCallDetails(callId);
    return call?.monitor?.controlUrl || "";
}

async function injectAssistantMessage(callId, controlUrl, content) {
    if (process.env.NODE_ENV === "test") {
        logger.info("Skipping live call injection in test mode", { callId });
        return { injected: true, transport: "test" };
    }

    const resolvedControlUrl = await resolveControlUrl(callId, controlUrl);
    if (!resolvedControlUrl) {
        throw new Error("No Vapi controlUrl available for live message injection.");
    }

    const response = await fetch(resolvedControlUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            type: "say",
            content,
            endCallAfterSpoken: false,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vapi live control failed with ${response.status}: ${errorText}`);
    }

    return {
        injected: true,
        transport: "control-url",
        controlUrl: resolvedControlUrl,
    };
}

module.exports = {
    injectAssistantMessage,
    resolveControlUrl,
};
