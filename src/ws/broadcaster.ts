const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger").default;
const { getContext } = require("../utils/context");

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
let persistScheduled = false;
let persistInFlight = false;
let persistDirty = false;

// Load persisted events from disk on boot
try {
    if (fs.existsSync(EVENTS_FILE)) {
        eventStore = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
        eventCounter = eventStore.length;
        logger.info("Persisted events loaded from disk", { count: eventStore.length });
    }
} catch (e) {
    logger.warn("Could not load persisted events, starting fresh", { error: e.message });
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
        logger.info("New WebSocket client connected", { totalClients: clients.size });

        // Send full event history to new client immediately
        ws.send(JSON.stringify({
            type: "HISTORY",
            events: eventStore
        }));

        ws.on("close", () => {
            clients.delete(ws);
            logger.info("WebSocket client disconnected", { totalClients: clients.size });
        });

        ws.on("error", (err) => {
            logger.error("WebSocket client error", { error: err.message });
            clients.delete(ws);
        });
    });

    logger.info("WebSocket server attached to HTTP server");
}

function schedulePersist() {
    persistDirty = true;
    if (persistScheduled) return;

    persistScheduled = true;
    setImmediate(async () => {
        persistScheduled = false;
        if (persistInFlight || !persistDirty) return;

        persistDirty = false;
        persistInFlight = true;

        try {
            await fs.promises.writeFile(EVENTS_FILE, JSON.stringify(eventStore), "utf-8");
        } catch (error) {
            logger.warn("Failed to persist events to disk", { error: error.message });
        } finally {
            persistInFlight = false;
            if (persistDirty) schedulePersist();
        }
    });
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
    const { traceId } = getContext();
    const event = {
        id: `evt_${++eventCounter}`,
        callId,
        traceId, // Correlate browser events with server logs 🫧
        type,
        data,
        ts: Date.now()
    };

    eventStore.push(event);

    // Keep store bounded — last 1000 events max for modern browsers
    if (eventStore.length > 1000) eventStore.shift();

    schedulePersist();

    // Broadcast to all live browser clients
    const message = JSON.stringify({ type: "EVENT", event });
    clients.forEach((client: any) => {
        if (client.readyState === 1) {
            try { client.send(message); }
            catch (err) { clients.delete(client); }
        }
    });

    logger.info(`Event pushed: ${type}`);
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
