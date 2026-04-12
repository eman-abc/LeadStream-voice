"use strict";

const { CallState: CallStateEnum } = require("../types");
const { queryGroq } = require("./actions");

/**
 * @typedef {Object} CallResponse
 * @property {string} content
 * @property {string} nextState
 * @property {boolean} redlined
 */

const REDLINE_KEYWORDS = [
    "investor", "salary", "discount", "competitor",
    "funding", "acquisition", "revenue", "lawsuit",
];

// Contact info patterns — if we see these, treat as data, never route to Groq
const CONTACT_PATTERNS = [
    /my name is/i,
    /i'?m\s+\w+/i,
    /email (is|address)/i,
    /@/,
    /\b[a-z]+\.[a-z]+@/i,
    /full name/i,
    /you can reach me/i,
    /call me\s+\w+/i,
];

// Farewell patterns — caller is done
const FAREWELL_PATTERNS = [
    /^no[,.]?\s*(that'?s?\s*all)?\.?$/i,
    /^(nope|nah|no thanks)\.?$/i,
    /that'?s all/i,
    /goodbye/i,
    /^bye/i,
    /thank you/i,
    /nothing else/i,
    /all set/i,
    /i'?m\s*(good|all set|done)/i,
    /have a great/i,
    /okay.*thank/i,
    /alright.*thank/i,
];

/**
 * handleRouting — main state-machine entry point.
 * @param {string} transcript - The exact user utterance
 * @param {string} currentState - Current call state
 * @param {{ name?: string, email?: string }} [entityContext] - Already extracted entities
 * @param {Array<{role: string, content: string}>} [history] - Full conversation so far
 */
async function handleRouting(transcript, currentState, entityContext, history) {
    entityContext = entityContext || {};
    history = history || [];
    const lower = transcript.toLowerCase().trim();

    // REDLINE GATE
    const isRedlined = REDLINE_KEYWORDS.some((kw) => lower.includes(kw));
    if (isRedlined) {
        return {
            content:
                "I appreciate you asking, but I'm not able to discuss Dino Software's internal " +
                "financials or competitive positioning. I'd be happy to tell you about our " +
                "modernization products or help you book a consultation instead.",
            nextState: CallStateEnum.REDLINE,
            redlined: true,
        };
    }

    // Check if we already have both entities — skip data collection prompts
    const hasName = entityContext.name && entityContext.name !== "Unknown";
    const hasEmail = entityContext.email && entityContext.email.length > 0;
    const hasAllEntities = hasName && hasEmail;

    switch (currentState) {

        case CallStateEnum.GREETING: {
            const next = detectNextState(lower);
            if (next === CallStateEnum.DATA_COLLECTION && !hasAllEntities) {
                const missingPrompt = buildMissingEntityPrompt(hasName, hasEmail);
                return {
                    content: `Absolutely! ${missingPrompt}`,
                    nextState: CallStateEnum.DATA_COLLECTION,
                    redlined: false,
                };
            }
            if (next === CallStateEnum.DATA_COLLECTION && hasAllEntities) {
                return {
                    content: `Perfect, I have your details on file! A solutions architect will be in touch at ${entityContext.email}. Is there anything else I can help with?`,
                    nextState: CallStateEnum.CONFIRM_CLOSE,
                    redlined: false,
                };
            }
            const groqResponse = await queryGroq(transcript, history, entityContext);
            return { content: groqResponse, nextState: CallStateEnum.INFO_SEARCH, redlined: false };
        }

        case CallStateEnum.INFO_SEARCH: {
            const next = detectNextState(lower);
            if (next === CallStateEnum.DATA_COLLECTION && !hasAllEntities) {
                const missingPrompt = buildMissingEntityPrompt(hasName, hasEmail);
                return {
                    content: `Great! ${missingPrompt}`,
                    nextState: CallStateEnum.DATA_COLLECTION,
                    redlined: false,
                };
            }
            if (next === CallStateEnum.DATA_COLLECTION && hasAllEntities) {
                return {
                    content: `I've already got your info — a solutions architect will reach out to ${entityContext.email} shortly. Anything else?`,
                    nextState: CallStateEnum.CONFIRM_CLOSE,
                    redlined: false,
                };
            }
            const groqResponse = await queryGroq(transcript, history, entityContext);
            return { content: groqResponse, nextState: CallStateEnum.INFO_SEARCH, redlined: false };
        }

        case CallStateEnum.DATA_COLLECTION: {
            const isContactInfo = CONTACT_PATTERNS.some((p) => p.test(transcript));

            if (isContactInfo) {
                // We received name/email — confirm and move to close
                const confirmLine = hasEmail
                    ? `Perfect, I've got your details. A solutions architect will be in touch at ${entityContext.email}. Is there anything else I can help you with?`
                    : "Perfect, I've got your details! A solutions architect will be in touch shortly. Is there anything else I can help you with?";
                return {
                    content: confirmLine,
                    nextState: CallStateEnum.CONFIRM_CLOSE,
                    redlined: false,
                };
            }

            // For anything else, let Groq handle it with full context.
            // The entity-aware system prompt tells Alex what she's still missing
            // and she'll ask for it naturally — no mechanical string injection.
            const groqResponse = await queryGroq(transcript, history, entityContext);
            return {
                content: groqResponse,
                nextState: CallStateEnum.DATA_COLLECTION,
                redlined: false,
            };
        }

        case CallStateEnum.CONFIRM_CLOSE: {
            const isFarewell = FAREWELL_PATTERNS.some((p) => p.test(transcript));

            if (isFarewell) {
                return {
                    content: "Thank you for calling Dino Software. Have a great day!",
                    nextState: CallStateEnum.END_CALL,
                    redlined: false,
                };
            }

            const next = detectNextState(lower);
            if (next === CallStateEnum.INFO_SEARCH) {
                const groqResponse = await queryGroq(transcript, history, entityContext);
                return { content: groqResponse, nextState: CallStateEnum.CONFIRM_CLOSE, redlined: false };
            }

            return {
                content: "Thank you for calling Dino Software. Have a great day!",
                nextState: CallStateEnum.END_CALL,
                redlined: false,
            };
        }

        case CallStateEnum.REDLINE: {
            const next = detectNextState(lower);
            if (next === CallStateEnum.INFO_SEARCH) {
                const groqResponse = await queryGroq(transcript, history, entityContext);
                return { content: groqResponse, nextState: CallStateEnum.INFO_SEARCH, redlined: false };
            }
            return {
                content:
                    "I understand, but that topic is outside what I can discuss. " +
                    "Can I help you with something about our products instead?",
                nextState: CallStateEnum.REDLINE,
                redlined: true,
            };
        }

        case CallStateEnum.END_CALL:
            return {
                content: "Thank you for calling Dino Software. Have a great day!",
                nextState: CallStateEnum.END_CALL,
                redlined: false,
            };

        default:
            return {
                content: "Welcome to Dino Software. I'm Alex. How can I help you today?",
                nextState: CallStateEnum.GREETING,
                redlined: false,
            };
    }
}

/**
 * Builds the right entity-collection prompt based on what's already known.
 */
function buildMissingEntityPrompt(hasName, hasEmail) {
    if (!hasName && !hasEmail) return "Could I get your full name and the best email address to reach you?";
    if (!hasName) return "Could I get your full name?";
    if (!hasEmail) return "And what's the best email address to reach you?";
    return "";
}

function detectNextState(lower) {
    const demoTriggers = [
        "demo", "consult", "meeting", "talk", "schedule",
        "book", "connect", "speak to", "set up a call",
    ];
    const infoTriggers = [
        "dinoscan", "dinomigrate", "dinoguard", "product", "price",
        "cost", "how", "what", "tell me", "explain", "cobol",
        "mainframe", "legacy", "migrate", "modernize", "service",
        "offer", "summarize", "features", "works",
    ];

    if (demoTriggers.some((t) => lower.includes(t))) return CallStateEnum.DATA_COLLECTION;
    if (infoTriggers.some((t) => lower.includes(t))) return CallStateEnum.INFO_SEARCH;

    return CallStateEnum.INFO_SEARCH;
}

module.exports = { handleRouting, REDLINE_KEYWORDS };