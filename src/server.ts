"use strict";
const dotenv = require('dotenv');
dotenv.config(); // Loads the .env file FIRST
const express = require('express');
const vapiRouter = require('./controllers/vapiController');
const { initWebSocketServer, getEventStore } = require("./ws/broadcaster");
const http = require("http");
const path = require("path");

// Load environment variables from .env file
dotenv.config();
console.log("[ENV] GROQ_API_KEY loaded:", !!process.env.GROQ_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, "../public")));

app.set('trust proxy', 1); // 👈 Add this line

app.get("/", (req, res) => {
    res.redirect("/dashboard");
});

// --- Chrome DevTools Silencer ---
// Chrome automatically looks for this file. We give it an empty JSON object to stop the 404/CSP errors.
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
    res.json({ status: "ok", service: "Dino Triage Platform", ts: Date.now() });

});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/dashboard.html"));
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
