"use strict";

const Groq = require("groq-sdk");
const { knowledgeBase } = require("../data/knowledgeLoader");

// Stop sequences — hard mechanical fence, max 4 (Groq API limit).
// If the model tries to write a simulated user turn, generation halts immediately.
const STOP_SEQUENCES = ["\nUser:", "\nCaller:", "User:", "Human:"];

/**
 * Build a system prompt that injects known entity context so the LLM
 * never re-asks for name/email that the caller has already provided.
 * @param {{ name?: string, email?: string }} context
 */
function buildSystemPrompt(context) {
    context = context || {};
    const entityBlock = [];
    if (context.name && context.name !== "Unknown") {
        entityBlock.push(`- Caller name already captured: "${context.name}" — do NOT ask for it again.`);
    }
    if (context.email && context.email.length > 0) {
        entityBlock.push(`- Caller email already captured: "${context.email}" — do NOT ask for it again.`);
    }

    const entitySection = entityBlock.length
        ? `\nKNOWN CALLER ENTITIES (do NOT re-collect these):\n${entityBlock.join("\n")}\n`
        : "";

    return `You are Alex, the AI receptionist for Dino Software.

Dino Software modernizes legacy enterprise systems (COBOL, Mainframe, old Java) using Agentic AI. Your three products are DinoScan, DinoMigrate, and DinoGuard.

STRICT RULES:
1. Answer ONLY using the knowledge base provided below. Never invent facts.
2. This is a LIVE phone call API. You receive ONE caller utterance per request. Respond with ONE reply only.
3. Keep your response under 2 sentences. Be direct and concise.
4. Never mention competitors, pricing not in the KB, or internal company details.
5. If the question cannot be answered from the KB, say: "That's a great question — let me have a solutions architect follow up with you directly. Could I get your name and email?"
6. Always end product answers by offering to book a consultation.
7. NEVER write "User:", "Caller:", or "Human:" — you are only Alex. Stop after your single reply.
8. Do NOT ask for information the caller has already provided.
${entitySection}
KNOWLEDGE BASE:
${knowledgeBase}`;
}

/**
 * queryGroq — calls Groq with the full conversation history for accurate context,
 * stop sequences to prevent autocomplete hallucination, and a structural user-message
 * instruction that enforces single-turn output.
 *
 * @param {string} transcript - The current user utterance
 * @param {Array<{role: string, content: string}>} [history] - Prior conversation turns
 * @param {{ name?: string, email?: string }} [context] - Already-known caller entities
 * @returns {Promise<string>} Alex's spoken response
 */
async function queryGroq(transcript, history, context) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const startTime = Date.now();

    // OPTION 3 — Structural user message: append a single explicit stop instruction
    // at the point closest to generation. This is the most proximate constraint.
    const userMessage = `${transcript}\n\n[Respond with ONLY your next spoken line. Stop after one response. Do not write "User:" or "Caller:".]`;

    // OPTION 1 — Full conversation history as messages[]
    // Build the Groq messages array: system + prior turns + current user message.
    // Prior turns give the model full context so it can't "autocomplete" the conversation.
    const priorMessages = (history || []).map(turn => ({
        role: turn.role === "bot" ? "assistant" : "user",
        content: turn.content,
    }));

    const messages = [
        { role: "system", content: buildSystemPrompt(context) },
        ...priorMessages,
        { role: "user", content: userMessage },
    ];

    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages,
            max_tokens: 100,    // ~2 sentences max — hard ceiling
            temperature: 0.1,   // Deterministic, not creative
            stream: false,
            // OPTION 2 — Stop sequences: hard mechanical fence
            // If the model tries to write "User:" it stops generation immediately.
            stop: STOP_SEQUENCES,
        });

        const raw = completion.choices[0]?.message?.content?.trim()
            ?? "Let me have a specialist follow up with you on that.";

        // Post-process: strip any leaked role labels that slipped past the stop sequences
        const response = raw
            .replace(/^(Alex:|Assistant:|Bot:)\s*/i, "")
            .trim();

        const latency = Date.now() - startTime;
        console.log(`[GROQ] Responded in ${latency}ms | turns_in_context=${priorMessages.length}`);
        console.log(`[GROQ] Response: "${response}"`);

        return response;

    } catch (err) {
        const latency = Date.now() - startTime;
        console.error(`[GROQ] Error after ${latency}ms:`, err.message);
        return "I'm having a little trouble with that right now. Could I take your details and have a specialist call you back?";
    }
}

module.exports = { queryGroq };