"use strict";

const Groq = require("groq-sdk");
const { knowledgeBase } = require("../data/knowledgeLoader");

// Stop sequences — max 4 limits for Groq API
const STOP_SEQUENCES = ["\nUser:", "\nCaller:", "User:", "\n\n"];

function logGroq(message, error = false) {
    if (process.env.NODE_ENV === "test") return;
    if (error) {
        console.error(message);
        return;
    }
    console.log(message);
}

/**
 * buildSystemPrompt — clean, priority-ordered rules.
 * Fewer rules = better compliance from small models.
 */
function buildSystemPrompt(context) {
    context = context || {};

    // Build entity awareness block — only shown when entities are known
    const knownEntities = [];
    if (context.name && context.name !== "Unknown") {
        knownEntities.push(`Name: "${context.name}"`);
    }
    if (context.email && context.email.length > 0) {
        knownEntities.push(`Email: "${context.email}"`);
    }

    const entityBlock = knownEntities.length > 0
        ? `\nYOU ALREADY KNOW THIS ABOUT THE CALLER — never ask for these again:\n${knownEntities.join("\n")}\n`
        : "\nYou have not yet captured the caller's name or email.\n";

    return `You are Alex, a professional receptionist for Dino Software.
Dino Software helps enterprises migrate legacy systems (COBOL, Mainframe, old Java) to modern stacks using AI-assisted tools: DinoScan, DinoMigrate, and DinoGuard.

YOUR VOICE AND STYLE:
- Warm, confident, and concise. This is a phone call — 1-2 sentences per reply only.
- You are a receptionist, not an engineer. You connect callers to the right people.
- Never use filler phrases like "Great question!" or "Absolutely!".
- Never claim to have done something you cannot do (scheduling, booking, sending emails).
  Say "I'll make sure a specialist reaches out" — not "I've scheduled a call for you."

WHAT YOU CAN DO:
- Answer questions about DinoScan, DinoMigrate, DinoGuard using the knowledge base below.
- Explain what Dino Software does at a high level.
- Capture the caller's name and email so a specialist can follow up.
- Offer to connect the caller with a solutions architect.

WHAT YOU CANNOT DO — handle these with a single honest sentence then redirect:
- Compare Dino Software to any competitor (IBM, Kyndryl, Accenture, etc.)
  → Say: "I'm not the right person to make that comparison — our solutions architect 
    can walk you through how we approach migration differently."
- Quote specific timelines, guarantees, or ROI figures not in the knowledge base.
  → Say: "I wouldn't want to give you an inaccurate figure — let me get a specialist 
    to give you the real numbers."
- Discuss pricing, discounts, or contract terms.
  → Say: "Pricing is scoped per engagement — a quick call with our team will give 
    you an accurate picture."
- Make any claims about risk, safety, or superiority over competitors.

CONTACT CAPTURE RULES — follow this priority exactly:
1. If you already know the caller's name AND email (see block below), do NOT ask again.
   Acknowledge by name if natural. Confirm their email only if they seem confused.
2. If you are missing name or email, ask for whichever is missing — one field at a time.
3. If the caller declines contact capture once, make one gentle second attempt:
   "No problem — if you change your mind, I can at least send a free legacy 
   modernisation overview to your email. Totally up to you."
4. If they decline twice, drop it gracefully and close warmly.
${entityBlock}
KNOWLEDGE BASE — answer product questions from this only:
${knowledgeBase}`;
}

/**
 * queryGroq — sends conversation history + current turn to Groq.
 * History gives the model full context so it cannot "forget" captured entities.
 */
async function queryGroq(transcript, history, context) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const startTime = Date.now();

    const priorMessages = (history || []).map(turn => ({
        role: turn.role === "bot" ? "assistant" : "user",
        content: turn.content,
    }));

    // Keep history bounded — last 10 turns max to avoid context bloat
    const boundedHistory = priorMessages.slice(-10);

    const messages = [
        { role: "system", content: buildSystemPrompt(context) },
        ...boundedHistory,
        {
            role: "user",
            content: transcript
        },
    ];

    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages,
            max_tokens: 120,
            temperature: 0.2,   // Slight warmth — pure 0.1 sounds robotic
            stream: false,
            stop: STOP_SEQUENCES,
        });

        const raw = completion.choices[0]?.message?.content?.trim()
            ?? "Let me have a specialist follow up with you on that.";

        // Strip any leaked role labels
        const response = raw
            .replace(/^(Alex:|Assistant:|Bot:|A:)\s*/i, "")
            .replace(/\n[\s\S]*/g, "") // strip anything after first newline
            .trim();

        const latency = Date.now() - startTime;
        logGroq(`[GROQ] ${latency}ms | context=${boundedHistory.length} turns | "${response}"`);

        return response;

    } catch (err) {
        logGroq(`[GROQ] Error: ${err.message}`, true);
        return "I'm having a little trouble right now — could I take your details and have someone call you back?";
    }
}

module.exports = { queryGroq };
