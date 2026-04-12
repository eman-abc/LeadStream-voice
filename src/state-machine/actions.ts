"use strict";

const Groq = require("groq-sdk");
const { knowledgeBase } = require("../data/knowledgeLoader");

const SYSTEM_PROMPT = `You are Riley, the AI receptionist for Dino Software.

Dino Software modernizes legacy enterprise systems (COBOL, Mainframe, old Java) using
Agentic AI. Your three products are DinoScan, DinoMigrate, and DinoGuard.

STRICT RULES:
1. Answer ONLY using the knowledge base provided below. Never invent facts.
2. This is a phone call. Keep every response under 2 sentences. Be direct.
3. Never mention competitors, pricing not in the KB, or internal company details.
4. If the question cannot be answered from the KB, say:
   "That's a great question — let me have a solutions architect follow up with you
   directly. Could I get your name and email?"
5. Always end product answers by offering to book a consultation.

KNOWLEDGE BASE:
${knowledgeBase}`;

/**
 * queryGroq — sends the caller's transcript to Groq with the KB as context.
 *
 * @param {string} transcript - The caller's question
 * @returns {Promise<string>} Riley's spoken response
 */
async function queryGroq(transcript) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log("[GROQ] API Key loaded:", !!process.env.GROQ_API_KEY);

    const startTime = Date.now();

    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: transcript },
            ],
            max_tokens: 120,       // ~2 sentences max — keeps it conversational
            temperature: 0.2,      // Low = consistent, on-script responses
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
        // Graceful fallback — call stays alive even if Groq fails
        return "I'm having a little trouble accessing that information right now. " +
            "Could I take your details and have a specialist call you back?";
    }
}

module.exports = { queryGroq };