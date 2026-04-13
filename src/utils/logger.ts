"use strict";

import winston from "winston";
import path from "path";
import fs from "fs";
import { getContext } from "./context";

// ── Ensure the logs directory exists ─────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, "../../logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── Custom format: inject callId + traceId from the AsyncLocalStorage bubble ─
const contextFormat = winston.format((info) => {
    const { callId, traceId } = getContext();
    info.callId  = callId;
    info.traceId = traceId;
    return info;
});

// ── Pretty console format (dev / containers) ──────────────────────────────────
const prettyConsole = winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, callId, traceId, ...meta }) => {
        const id    = callId  && callId  !== "no-context" ? ` [${String(callId).slice(0, 8)}]`     : "";
        const trace = traceId && traceId !== "no-trace"   ? ` [tr:${String(traceId).slice(0, 8)}]` : "";
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        return `${timestamp} [${level}]${id}${trace}: ${message}${metaStr}`;
    })
);

// ── Central logger ────────────────────────────────────────────────────────────
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",

    format: winston.format.combine(
        contextFormat(),
        winston.format.timestamp(),
        winston.format.errors({ stack: true })
    ),

    transports: [
        // Human-friendly colorized output to stdout
        new winston.transports.Console({
            format: winston.format.combine(
                contextFormat(),
                winston.format.timestamp(),
                prettyConsole
            ),
        }),

        // Structured JSON file — grep-able, ingestible by Datadog / Loki / Grafana
        new winston.transports.File({
            filename: path.join(LOGS_DIR, "app.log"),
            maxsize:  10 * 1024 * 1024,   // 10 MB — rotate after this
            maxFiles: 5,
            tailable: true,
            format: winston.format.combine(
                contextFormat(),
                winston.format.timestamp(),
                winston.format.json()        // every line → valid JSON object
            ),
        }),
    ],
});

export default logger;
