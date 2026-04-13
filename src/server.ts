"use strict";

const dotenv = require('dotenv');
dotenv.config(); // Loads the .env file FIRST

const express = require('express');
const vapiRouter = require('./controllers/vapiController');
const { initAsyncLlmQueue } = require("./services/asyncLlmQueue");
const { initCallSessionStore } = require("./services/callSessionStore");
const { initWebSocketServer, getEventStore } = require("./ws/broadcaster");
const http = require("http");
const path = require("path");
const logger = require("./utils/logger").default;

// Load environment variables from .env file
dotenv.config();
logger.info("[ENV] GROQ_API_KEY loaded", { present: !!process.env.GROQ_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, "../public")));

app.set('trust proxy', 1);

app.get("/", (req, res) => {
    res.redirect("/dashboard");
});

// --- Chrome DevTools Silencer ---
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
    res.status(200).json({});
});

// HTTP fallback for event history (polling)
app.get("/api/events", (req, res) => {
    res.json({ events: getEventStore() });
});

// Routes
app.use('/vapi', vapiRouter);

// Health check — visible in browser
app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "LeadStream Voice", ts: Date.now() });
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/dashboard.html"));
});

// Start server
const httpServer = http.createServer(app);
initWebSocketServer(httpServer);
const ready = initCallSessionStore().then(() => initAsyncLlmQueue());

module.exports = { app, httpServer, ready };

if (process.env.NODE_ENV !== 'test') {
    ready
        .then(() => {
            httpServer.listen(PORT, () => {
                logger.info("LeadStream Voice started", {
                    port: PORT,
                    webhook: `http://localhost:${PORT}/vapi/webhook`,
                    dashboard: `http://localhost:${PORT}/dashboard`,
                });
            });
        })
        .catch((error) => {
            logger.error("Failed to initialize call session store", { error: error.message });
            process.exit(1);
        });
}
