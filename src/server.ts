"use strict";

const dotenv = require('dotenv');
const express = require('express');
const vapiRouter = require('./controllers/vapiController');

// Load environment variables from .env file
dotenv.config();
console.log("[ENV] GROQ_API_KEY loaded:", !!process.env.GROQ_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/vapi', vapiRouter);

// Basic health check endpoint
app.get('/health', (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
module.exports = { app };

app.listen(PORT, () => {
    console.log(`✓ Dino Triage Platform listening on port ${PORT}`);
    console.log(`✓ Webhook endpoint: POST http://localhost:${PORT}/vapi/webhook`);
});
