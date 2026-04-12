"use strict";

const Groq = require("groq-sdk");
const { knowledgeBase } = require("../data/knowledgeLoader");

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
2. This is a phone call. Keep every response under 2 sentences. Be direct and concise.
3. Never mention competitors, pricing not in the KB, or internal company details.
4. If the question cannot be answered from the KB, say: "That's a great question — let me have a solutions architect follow up with you directly. Could I get your name and email?"
5. Always end product answers by offering to book a consultation.
6. ONLY respond to the single user utterance provided. Do NOT simulate or continue the conversation.
7. Do NOT generate hypothetical dialogue, example responses, or placeholder text.
8. Do NOT ask for information the caller has already provided.
${entitySection}
KNOWLEDGE BASE:
${knowledgeBase}`;
}

/**
 * queryGroq — sends the caller's transcript to Groq with the KB and entity context.
 *
 * @param {string} transcript - The caller's question (single utterance only)
 * @param {{ name?: string, email?: string }} [context] - Already-known caller entities
 * @returns {Promise<string>} Alex's spoken response
 */
async function queryGroq(transcript, context) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const startTime = Date.now();

    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: buildSystemPrompt(context) },
                { role: "user", content: transcript },
            ],
            max_tokens: 100,   // ~2 sentences — keeps it conversational
            temperature: 0.1,  // Lower = more deterministic, far less hallucination
            stream: false,
        });

        const response = completion.choices[0]?.message?.content?.trim()
            ?? "Let me have a specialist follow up with you on that.";

        const latency = Date.now() - startTime;
        console.log(`[GROQ] Responded in ${latency}ms`);
        console.log(`[GROQ] Response: "${response}"`);

        return response;

    } catch (err) {
        const latency = Date.now() - startTime;
        console.error(`[GROQ] Error after ${latency}ms:`, err.message);
        return "I'm having a little trouble with that right now. Could I take your details and have a specialist call you back?";
    }
}

module.exports = { queryGroq };