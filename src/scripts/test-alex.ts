"use strict";

require("dotenv").config();
const readline = require("readline");
const { queryGroq } = require("../state-machine/actions");
const { extractName, extractEmail } = require("../services/leadParser");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// State Tracking
const conversationHistory = [];
const entityContext = { name: "Unknown", email: "" };

// Console Colors
const COLOR_RESET = "\x1b[0m";
const COLOR_USER = "\x1b[36m"; // Cyan
const COLOR_ALEX = "\x1b[32m"; // Green
const COLOR_INFO = "\x1b[33m"; // Yellow

console.log(`${COLOR_INFO}==========================================`);
console.log(`🤖 Alex Live Test Environment Loaded`);
console.log(`Type 'exit' or 'quit' to end the session.`);
console.log(`==========================================${COLOR_RESET}\n`);
console.log(`${COLOR_ALEX}[ALEX] > Welcome to Dino Software. I'm Alex. How can I help you today?${COLOR_RESET}`);

// Initial bot prompt added to history
conversationHistory.push({ role: "bot", content: "Welcome to Dino Software. I'm Alex. How can I help you today?" });

function askQuestion() {
    rl.question(`${COLOR_USER}[YOU] > `, async (input) => {
        const transcript = input.trim();

        if (transcript.toLowerCase() === "exit" || transcript.toLowerCase() === "quit") {
            console.log(`${COLOR_INFO}Ending session. Goodbye!${COLOR_RESET}`);
            rl.close();
            return;
        }

        if (!transcript) {
            askQuestion();
            return;
        }

        // Live Entity Tracking
        const detectedName = extractName(transcript);
        const detectedEmail = extractEmail(transcript);
        if (detectedName !== "Unknown") entityContext.name = detectedName;
        if (detectedEmail) entityContext.email = detectedEmail;

        // Process thinking indicator
        process.stdout.write(`${COLOR_INFO}Alex is thinking...${COLOR_RESET}\r`);

        try {
            // Send to Groq
            const response = await queryGroq(transcript, conversationHistory, entityContext);

            // Print the response (overwrites the 'thinking...' line)
            process.stdout.write("\x1b[2K\r"); // Clear line
            console.log(`${COLOR_ALEX}[ALEX] > ${response}${COLOR_RESET}`);
            
            // Print diagnostic info
            console.log(`${COLOR_INFO}(Context turns: ${conversationHistory.length} | Known Entities: Name='${entityContext.name}', Email='${entityContext.email}')${COLOR_RESET}\n`);

            // Update history
            conversationHistory.push({ role: "user", content: transcript });
            conversationHistory.push({ role: "bot", content: response });

            // Cap history
            if (conversationHistory.length > 20) {
                conversationHistory.splice(0, conversationHistory.length - 20);
            }
        } catch (err) {
             process.stdout.write("\x1b[2K\r"); // Clear line
             console.error(`${COLOR_INFO}Error: ${err.message}${COLOR_RESET}`);
        }

        // Loop
        askQuestion();
    });
}

askQuestion();
