"use strict";

const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "../../logs");
const EVENTS_FILE = path.join(LOGS_DIR, "events.json");

// Ensure logs dir exists
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

/**
 * EVENT STORE — persisted to logs/events.json so the dashboard survives server restarts.
 * @type {Array<{id: string, callId: string, type: string, data: any, ts: number}>}
 */
let eventStore = [];
let eventCounter = 0;

// Load persisted events from disk on boot
try {
    if (fs.existsSync(EVENTS_FILE)) {
        eventStore = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
        eventCounter = eventStore.length;
        console.log(`[WS] Loaded ${eventStore.length} persisted events from disk.`);
    }
} catch (e) {
    console.warn("[WS] Could not load persisted events, starting fresh:", e.message);
    eventStore = [];
}

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

/** @type {import('ws').WebSocketServer | null} */
let wss = null;

/**
 * initWebSocketServer — attach WSS to the existing HTTP server.
 * Call this once in server.ts after app.listen().
 * @param {import('http').Server} httpServer
 */
function initWebSocketServer(httpServer) {
    wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws) => {
        clients.add(ws);
        console.log(`[WS] Client connected. Total: ${clients.size}`);

        // Send full event history to new client immediately
        // This means opening the dashboard mid-session shows all past events
        ws.send(JSON.stringify({
            type: "HISTORY",
            events: eventStore
        }));

        ws.on("close", () => {
            clients.delete(ws);
            console.log(`[WS] Client disconnected. Total: ${clients.size}`);
        });

        ws.on("error", (err) => {
            console.error("[WS] Client error:", err.message);
            clients.delete(ws);
        });
    });

    console.log("[WS] WebSocket server attached to HTTP server");
}

/**
 * pushEvent — store an event and broadcast to all connected clients.
 * This is called throughout the call lifecycle, not just at end.
 *
 * @param {string} callId
 * @param {string} type - e.g. "CALL_STARTED", "TURN", "REDLINE", "CALL_ENDED"
 * @param {any} data - any serializable object
 */
function pushEvent(callId, type, data) {
    const event = {
        id: `evt_${++eventCounter}`,
        callId,
        type,
        data,
        ts: Date.now()
    };

    eventStore.push(event);

    // Keep store bounded — last 500 events max
    if (eventStore.length > 500) eventStore.shift();

    // Persist to disk — survives server restarts
    try {
        fs.writeFileSync(EVENTS_FILE, JSON.stringify(eventStore), "utf-8");
    } catch (e) { /* non-fatal */ }

    // Broadcast to all live browser clients
    const message = JSON.stringify({ type: "EVENT", event });
    clients.forEach((client: any) => {
        if (client.readyState === 1) {
            try { client.send(message); }
            catch (err) { clients.delete(client); }
        }
    });

    console.log(`[WS] Pushed ${type} for call ${callId.slice(0, 8)}...`);
}

/**
 * getEventStore — returns full event history.
 * Used by GET /api/events for HTTP polling fallback.
 * @returns {typeof eventStore}
 */
function getEventStore() {
    return [...eventStore];
}

module.exports = { initWebSocketServer, pushEvent, getEventStore };
