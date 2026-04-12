"use strict";

const dotenv = require('dotenv');
const express = require('express');
const vapiRouter = require('./controllers/vapiController');
const { initWebSocketServer, getEventStore } = require("./ws/broadcaster");
const http = require("http");

// Load environment variables from .env file
dotenv.config();
console.log("[ENV] GROQ_API_KEY loaded:", !!process.env.GROQ_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

const path = require("path");
app.use(express.static(path.join(__dirname, "../public")));

// HTTP fallback for event history (polling)
app.get("/api/events", (req, res) => {
    res.json({ events: getEventStore() });
});

// Routes
app.use('/vapi', vapiRouter);

// Health check — visible in browser
app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "Dino Triage Platform", ts: Date.now() });

});

// Start server
const httpServer = http.createServer(app);
initWebSocketServer(httpServer);

module.exports = { app, httpServer };

if (process.env.NODE_ENV !== 'test') {
    httpServer.listen(PORT, () => {
        console.log(`✓ Dino Triage Platform listening on port ${PORT}`);
        console.log(`✓ Webhook endpoint: POST http://localhost:${PORT}/vapi/webhook`);
        console.log(`✓ Dashboard: http://localhost:${PORT}/dashboard`);
    });
}
