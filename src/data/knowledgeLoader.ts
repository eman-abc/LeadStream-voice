"use strict";

const fs = require("fs");
const path = require("path");

// Read synchronously at module load time — happens once at startup, not per call
const KB_PATH = path.join(__dirname, "../../docs/dino-kb.md");

let knowledgeBase = "";

try {
    knowledgeBase = fs.readFileSync(KB_PATH, "utf-8");
    console.log("[KB] Knowledge base loaded successfully. Length:", knowledgeBase.length, "chars");
} catch (err) {
    console.error("[KB] FATAL: Could not load knowledge base at:", KB_PATH);
    console.error("[KB] Ensure docs/dino-kb.md exists before starting the server.");
    process.exit(1);  // Hard fail — don't run without KB
}

module.exports = { knowledgeBase };