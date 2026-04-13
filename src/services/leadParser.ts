"use strict";

/**
 * @typedef {Object} LeadPayload
 * @property {string} callId
 * @property {string} timestamp
 * @property {{ name: string, email: string }} customer
 * @property {"demo_request"|"pricing_inquiry"|"general_inquiry"|"unqualified"} intent
 * @property {string} summary
 * @property {boolean} redlineFlagged
 */

/**
 * extractName — scans transcript for "my name is X" or "I'm X" patterns.
 * Returns "Unknown" if nothing found.
 * @param {string} transcript
 * @returns {string}
 */
function extractName(transcript) {
    const patterns = [
        /my name is ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
        /i(?:'m| am) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
        /call me ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
        /this is ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
    ];
    for (const pattern of patterns) {
        const match = transcript.match(pattern);
        if (match) return match[1].trim();
    }
    return "Unknown";
}

/**
 * extractEmail — finds any email-shaped string in transcript.
 * Deepgram transcribes "at" as "at" and "dot" as "dot" in spoken email —
 * handle both the written form and the spoken form.
 * @param {string} transcript
 * @returns {string}
 */
function extractEmail(transcript) {
    // Standard written email
    const written = transcript.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (written) return written[0].toLowerCase();

    // Spoken form: "john dot smith at gmail dot com"
    const spoken = transcript.match(
        /([a-z0-9]+(?:\s+dot\s+[a-z0-9]+)*)\s+at\s+([a-z0-9]+)\s+dot\s+([a-z]{2,})/i
    );
    if (spoken) {
        const local = spoken[1].replace(/\s+dot\s+/gi, ".");
        const domain = spoken[2];
        const tld = spoken[3];
        return `${local}@${domain}.${tld}`.toLowerCase();
    }

    return "";
}

/**
 * extractIntent — keyword-based intent classification from full transcript.
 * @param {string} transcript
 * @returns {"demo_request"|"pricing_inquiry"|"general_inquiry"|"unqualified"}
 */
function extractIntent(transcript) {
    const t = transcript.toLowerCase();
    if (t.includes("demo") || t.includes("trial") || t.includes("schedule") || t.includes("book"))
        return "demo_request";
    if (t.includes("price") || t.includes("cost") || t.includes("pricing") || t.includes("how much"))
        return "pricing_inquiry";
    if (t.includes("dinoscan") || t.includes("dinomigrate") || t.includes("dinoguard") ||
        t.includes("cobol") || t.includes("legacy") || t.includes("mainframe") ||
        t.includes("service") || t.includes("what do you"))
        return "general_inquiry";
    return "unqualified";
}

/**
 * wasRedlined — checks if any redline keyword appears in transcript.
 * Mirrors the REDLINE_KEYWORDS in router.ts — keep in sync.
 * @param {string} transcript
 * @returns {boolean}
 */
function wasRedlined(transcript) {
    const REDLINE_KEYWORDS = [
        "investor", "salary", "discount", "competitor",
        "funding", "acquisition", "revenue", "lawsuit"
    ];
    const t = transcript.toLowerCase();
    return REDLINE_KEYWORDS.some(k => t.includes(k));
}

/**
 * parseEndOfCallReport — main export. Converts raw VAPI report into LeadPayload.
 * @param {any} reportBody - req.body from the end-of-call-report webhook
 * @param {string} [historyTranscript] - Stored conversation history from controller
 * @returns {LeadPayload}
 */
function parseEndOfCallReport(reportBody, historyTranscript) {
    // Extract transcript from the end-of-call-report payload structure
    const artifact = reportBody?.artifact || reportBody?.message?.artifact || {};
    let artifactTranscript = artifact.transcript || "";

    // Fallback: Build a single string from all transcript messages for analysis
    if (!artifactTranscript) {
        const messages = artifact.messages || [];
        artifactTranscript = messages
            .filter(m => m.role === "user" || m.role === "bot" || m.role === "assistant")
            .map(m => m.message || m.content || "")
            .join(" ");
    }

    // Prefer the stored turn history (has name/email from turn 1) over the artifact.
    // Merge both so entities mentioned anywhere in the call are captured.
    const fullTranscript = [historyTranscript || "", artifactTranscript]
        .filter(Boolean)
        .join(" ");

    const callId = reportBody?.call?.id ||
                   reportBody?.message?.call?.id ||
                   "unknown";

    return {
        callId,
        timestamp: new Date().toISOString(),
        customer: {
            name: extractName(fullTranscript),
            email: extractEmail(fullTranscript),
        },
        intent: extractIntent(fullTranscript),
        summary: (historyTranscript || artifactTranscript).slice(0, 200).trim() || "No transcript available",
        redlineFlagged: wasRedlined(fullTranscript),
    };
}

module.exports = { parseEndOfCallReport, extractName, extractEmail };
