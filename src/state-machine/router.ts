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
    /thank you.*time/i,
    /nothing else/i,
    /i'?m\s*(good|all set|done)/i,
];

async function handleRouting(transcript, currentState) {
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

    switch (currentState) {

        case CallStateEnum.GREETING: {
            const next = detectNextState(lower);
            if (next === CallStateEnum.DATA_COLLECTION) {
                return {
                    content: "Absolutely! Could I get your full name and the best email address to reach you?",
                    nextState: CallStateEnum.DATA_COLLECTION,
                    redlined: false,
                };
            }
            const groqResponse = await queryGroq(transcript);
            return { content: groqResponse, nextState: CallStateEnum.INFO_SEARCH, redlined: false };
        }

        case CallStateEnum.INFO_SEARCH: {
            const next = detectNextState(lower);
            if (next === CallStateEnum.DATA_COLLECTION) {
                return {
                    content: "Great! Could I get your full name and the best email address to reach you?",
                    nextState: CallStateEnum.DATA_COLLECTION,
                    redlined: false,
                };
            }
            const groqResponse = await queryGroq(transcript);
            return { content: groqResponse, nextState: CallStateEnum.INFO_SEARCH, redlined: false };
        }

        case CallStateEnum.DATA_COLLECTION: {
            const isContactInfo = CONTACT_PATTERNS.some((p) => p.test(transcript));
            const next = detectNextState(lower);

            if (isContactInfo) {
                return {
                    content:
                        "Perfect, I've got your details! A solutions architect will be in touch shortly. " +
                        "Is there anything else I can help you with?",
                    nextState: CallStateEnum.CONFIRM_CLOSE,
                    redlined: false,
                };
            }

            if (next === CallStateEnum.INFO_SEARCH) {
                const groqResponse = await queryGroq(transcript);
                return {
                    content: groqResponse + " Now, could I grab your name and email to get you booked in?",
                    nextState: CallStateEnum.DATA_COLLECTION,
                    redlined: false,
                };
            }

            // Ambiguous — assume contact info
            return {
                content:
                    "Got it, thank you! A solutions architect will reach out to you shortly. " +
                    "Is there anything else I can help you with?",
                nextState: CallStateEnum.CONFIRM_CLOSE,
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
                const groqResponse = await queryGroq(transcript);
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
                const groqResponse = await queryGroq(transcript);
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