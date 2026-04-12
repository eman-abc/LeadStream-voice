# LeadStream-Voice

> **A production-grade AI voice triage platform** — inbound calls handled by a deterministic TypeScript state machine, routed through Groq's Llama-3 for sub-700ms responses, with structured lead capture delivered to a real-time dashboard.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Tech Stack](#tech-stack)
5. [Project Structure](#project-structure)
6. [Data Flow](#data-flow)
7. [State Machine](#state-machine)
8. [API Endpoints](#api-endpoints)
9. [Environment & Configuration](#environment--configuration)
10. [Getting Started](#getting-started)
11. [Running Tests](#running-tests)
12. [Deployment](#deployment)
13. [WebSocket Events](#websocket-events)
14. [Security](#security)
15. [Production Roadmap](#production-roadmap)

---

## Overview

LeadStream-Voice connects **VAPI** (voice AI telephony) to a custom Node.js/TypeScript backend that routes every inbound call through a strict five-state machine. Each turn of the conversation is classified, answered via Groq (Llama-3), and logged. When the call ends, a structured `LeadPayload` is extracted from the transcript, persisted to disk, and pushed to a live browser dashboard over WebSocket.

**Why this exists:** Most voice AI demos use opaque LLM agent loops that are hard to trace, debug, or control. LeadStream-Voice makes every routing decision a typed enum transition you can follow in a debugger — no LangChain, no LangGraph.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       PHASE A  (real-time)                     │
│                                                                │
│  Caller ──► VAPI ──► POST /vapi/webhook ──► vapiController.ts │
│              ▲          (tool-call event)          │           │
│              │                                     ▼           │
│              └──── result text ◄──── router.ts (switch)        │
│                                          │           │         │
│                                     Groq LLM    Hardcoded      │
│                                    + JSON KB     Redline       │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                       PHASE B  (async)                         │
│                                                                │
│  VAPI end-of-call-report ──► vapiController.ts                 │
│                                     │                          │
│                              leadParser.ts                     │
│                                     │                          │
│                           Groq extraction pass                 │
│                         (name, email, summary)                 │
│                                     │                          │
│                              LeadPayload{}                     │
│                         ┌───────────┴────────────┐            │
│                      crmMock.ts             logs/<id>.json     │
│                  [CRM_SYNC] console      disk persistence      │
│                  [WHATSAPP_API] log                            │
│                         └───────────┬────────────┘            │
│                               WebSocket push                   │
│                           ──► dashboard.html                   │
└────────────────────────────────────────────────────────────────┘
```

### Latency Budget (Phase A)

| Segment | Budget |
|---|---|
| Deepgram STT (via VAPI) | ~200 ms |
| Network + Express handler | ~50 ms |
| Groq Llama-3 TTFT | ~200 ms |
| ElevenLabs TTS start (via VAPI) | ~200 ms |
| **Total** | **< 700 ms** |

Redline responses bypass Groq entirely — those return in **< 100 ms**.

---

## Features

- **Real-time voice routing** — VAPI webhooks handled in under 700 ms end-to-end.
- **Deterministic state machine** — five typed enum states, every transition traceable.
- **Redline protection** — hardcoded keyword interception runs *before* the LLM is invoked; sensitive topics (investors, competitors, pricing discounts, etc.) are deflected without calling Groq.
- **Groq-powered answers** — `llama-3.1-8b-instant` answers product/pricing questions grounded in a local JSON knowledge base.
- **Post-call lead extraction** — a second Groq pass extracts customer name, email, and a 1-sentence call summary from the transcript.
- **Disk persistence** — every call produces a `logs/<callId>.json` file that survives server restarts.
- **Live dashboard** — `public/dashboard.html` receives push updates over WebSocket; shows call state, transcript turns, bot responses, and surfaced lead data.
- **Rate limiting** — `express-rate-limit` on the `/vapi/webhook` endpoint.
- **Session safety reaper** — in-memory sessions are automatically purged after 1 hour to prevent memory leaks on abandoned calls.
- **Duplicate call guard** — processed `toolCallId`s are deduplicated to prevent double-firing on VAPI retry.
- **Echo suppression** — bot responses are never re-routed if they surface as the next transcript input.
- **Structured logging** — Winston logger with timestamps on all INFO/WARN/ERROR events.
- **Test suite** — Jest + Supertest covering the lead parser, router, webhook handler, and WebSocket broadcaster.

---

## Tech Stack

| Layer | Tool | Rationale |
|---|---|---|
| Telephony | [VAPI](https://vapi.ai) | Manages WebRTC, Deepgram STT, ElevenLabs TTS |
| Server | Node.js 20 + Express 5 + TypeScript | Standard, typed, fast |
| Inference | [Groq SDK](https://groq.com) — `llama-3.1-8b-instant` | < 200 ms TTFT on voice; no LangChain overhead |
| State machine | Native TypeScript enums + switch | Deterministic, zero dependencies, debugger-friendly |
| Knowledge base | `src/data/knowledge.json` | Zero-latency lookup; no vector DB needed at this scale |
| Real-time push | WebSocket (`ws` library) | Live call events to the dashboard |
| Logging | Winston | Structured JSON logs to stdout and disk |
| Rate limiting | `express-rate-limit` | Webhook DoS protection |
| Testing | Jest + ts-jest + Supertest | Unit and integration coverage |
| Deployment | Docker (multi-stage) → Render | Reproducible, < 200 MB final image |
| Local tunnel | Ngrok | Webhook testing before Render deploy |

---

## Project Structure

```
leadstream-voice/
├── .env                        # Runtime secrets (git-ignored)
├── .env.example                # Committed — shows required keys, no values
├── .gitignore
├── .dockerignore
├── Dockerfile                  # Multi-stage build (builder → production)
├── package.json
├── tsconfig.json
├── docs/
│   ├── ARCHITECTURE.md         # Full design document
│   ├── dino-kb.md              # Knowledge base reference
│   └── provider-specs/
│       └── vapi-webhooks.md    # VAPI webhook event reference
├── logs/                       # Per-call JSON logs (git-ignored, persisted at runtime)
├── public/
│   └── dashboard.html          # Live call monitoring dashboard
└── src/
    ├── server.ts               # Express init, route mounting, WebSocket setup
    ├── types/
    │   └── index.ts            # CallState enum + LeadPayload interface
    ├── controllers/
    │   └── vapiController.ts   # Webhook ingestion, session management, call orchestration
    ├── state-machine/
    │   ├── router.ts           # switch(state) — the routing brain
    │   └── actions.ts          # Groq SDK call + prompt assembly
    ├── services/
    │   ├── leadParser.ts       # Extracts typed fields from VAPI transcript
    │   └── crmMock.ts          # Console-formatted CRM + WhatsApp simulation
    ├── ws/
    │   └── broadcaster.ts      # WebSocket server + event store
    ├── utils/
    │   └── logger.ts           # Winston logger instance
    ├── data/
    │   └── knowledge.json      # dino Software FAQ, pricing, redline triggers
    └── tests/
        ├── leadParser.test.ts
        ├── router.test.ts
        ├── webhook.test.ts
        └── websocket.test.ts
```

**Separation of concerns:** `vapiController.ts` never calls Groq directly. `router.ts` never touches the HTTP request object. `leadParser.ts` never calls the router. Every file has exactly one job.

---

## Data Flow

### Per-turn (Phase A)

```
1. Caller speaks
2. Deepgram (via VAPI) → text transcript
3. VAPI POST /vapi/webhook  { type: "tool-calls", callId, transcript }
4. vapiController.ts
   ├── Verify VAPI_SECRET header
   ├── Deduplicate toolCallId
   ├── Echo-suppress repeated transcript
   ├── Inline entity extraction (name, email) → entityMap
   ├── Append to conversationHistoryMap
   └── Call router.ts(state, transcript, entities, history)
5. router.ts
   ├── REDLINE keyword check (runs FIRST, no Groq)
   └── switch(CallState)
         GREETING        → welcome script + detectIntent()
         INFO_SEARCH     → queryGroq(transcript, knowledge.json)
         DATA_COLLECTION → data-collection prompt
         END_CALL        → closing script
6. vapiController.ts
   ├── Update callStateMap[callId]
   ├── Push TURN / REDLINE event over WebSocket
   └── Return { results: [{ toolCallId, result: responseText }] }
7. ElevenLabs (via VAPI) speaks response to caller
```

### Post-call (Phase B)

```
1. Caller hangs up
2. VAPI POST /vapi/webhook  { type: "end-of-call-report" }
3. vapiController.ts
   ├── Reconstruct transcript from conversationHistoryMap
   ├── leadParser.ts → coarse LeadPayload (regex)
   ├── Groq extraction pass → clean name, email
   ├── Groq summary pass → 1-sentence technical summary
   ├── Write logs/<callId>.json to disk
   ├── crmMock.ts → console [CRM_SYNC] + [WHATSAPP_API] blocks
   ├── Push CALL_ENDED event over WebSocket
   └── cleanUpSession(callId) → purge in-memory maps
```

---

## State Machine

```
                    ┌──────────────────────────────────────────┐
                    │  Any state + redline keyword detected     │
                    └─────────────────┬────────────────────────┘
                                      │ (LLM never called)
                                      ▼
GREETING ──► INFO_SEARCH ──► DATA_COLLECTION ──► END_CALL
                ▲                                    ▲
                │                                    │
                └─────── REDLINE → END_CALL ─────────┘
```

### States

| State | Behavior |
|---|---|
| `GREETING` | Entry — routes caller intent via `detectIntent()` keyword match |
| `INFO_SEARCH` | Calls Groq with transcript + knowledge.json; answers product/pricing questions |
| `DATA_COLLECTION` | Solicits name and email for lead capture |
| `REDLINE` | Hardcoded refusal; Groq is never invoked; session ends |
| `END_CALL` | Closing script; terminal state |

### Redline Topics

Defined in `src/data/knowledge.json` under `redline_topics`:

```
investor, funding, discount, competitor, salary, lawsuit, acquisition, revenue
```

Any transcript containing one of these keywords triggers an immediate hardcoded deflection, regardless of the current state.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/vapi/webhook` | Primary VAPI event receiver (tool-calls, assistant-request, end-of-call-report, etc.) |
| `GET` | `/health` | Liveness probe — returns `{ status: "ok", service, ts }` |
| `GET` | `/dashboard` | Serves `public/dashboard.html` |
| `GET` | `/api/events` | HTTP fallback — returns full in-memory event store (for polling) |
| `GET` | `/` | Redirects to `/dashboard` |

### VAPI Webhook Event Handling

| Event type | Action |
|---|---|
| `assistant-request` | Returns `{ assistant: { firstMessage } }` — Alex's opening line |
| `tool-calls` | Routes through state machine; returns `{ results: [{ toolCallId, result }] }` |
| `end-of-call-report` | Triggers Phase B lead pipeline |
| `transcript`, `speech-update`, `status-update`, `conversation-update`, `hang`, `transfer-update`, `user-interrupted` | Acknowledged with `{ received: true }` (passthrough) |

---

## Environment & Configuration

### `.env` (git-ignored)

```bash
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
VAPI_SECRET=your_webhook_secret_here
```

### `.env.example` (committed)

```bash
GROQ_API_KEY=
PORT=3000
VAPI_SECRET=
```

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | **Yes** | API key from [console.groq.com](https://console.groq.com) |
| `PORT` | No | HTTP port; defaults to `3000` |
| `VAPI_SECRET` | Recommended | Secret set in VAPI dashboard → Server URL headers; validated on every webhook |

---

## Getting Started

### Prerequisites

- Node.js 20+
- A [VAPI](https://vapi.ai) account with an assistant configured
- A [Groq](https://console.groq.com) API key
- [Ngrok](https://ngrok.com) (for local webhook testing)

### 1. Clone and install

```bash
git clone https://github.com/eman-abc/LeadStream-voice.git
cd LeadStream-voice
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — add GROQ_API_KEY and optionally VAPI_SECRET
```

### 3. Start the dev server

```bash
npm run dev
# → ✓ Dino Triage Platform listening on port 3000
# → ✓ Webhook endpoint: POST http://localhost:3000/vapi/webhook
# → ✓ Dashboard: http://localhost:3000/dashboard
```

### 4. Expose your local server via Ngrok

```bash
# In a second terminal
npx ngrok http 3000
# Copy the https://xxxx.ngrok-free.app URL
```

### 5. Configure VAPI

In your [VAPI dashboard](https://dashboard.vapi.ai):

1. Open your assistant → **Server URL** → set to `https://xxxx.ngrok-free.app/vapi/webhook`
2. If using `VAPI_SECRET`: add it as a header named `x-vapi-secret` in Server URL settings
3. Place a test call — watch the dashboard at `http://localhost:3000/dashboard`

### 6. Verify the pipeline

```
Terminal 1 (dev server):
  [ENV] GROQ_API_KEY loaded: true
  ✓ assistant-request received → firstMessage sent
  ✓ tool-calls received → routing → GREETING
  ✓ tool-calls received → routing → INFO_SEARCH
  [LOG] Call log saved → logs/<callId>.json

Terminal 2 (browser):
  Dashboard shows live TURN events, bot responses, and lead card on call end
```

---

## Running Tests

```bash
npm test
```

The test suite covers:

| File | Coverage |
|---|---|
| `leadParser.test.ts` | Email regex, name extraction, intent classification, redline detection |
| `router.test.ts` | State transitions, redline bypass, Groq mock responses |
| `webhook.test.ts` | Full HTTP integration via Supertest — all event types |
| `websocket.test.ts` | WebSocket broadcaster, event store, client push |

---

## Deployment

### Docker (local)

```bash
# Build
docker build -t leadstream-voice .

# Run
docker run -p 3000:3000 \
  -e GROQ_API_KEY=gsk_xxx \
  -e VAPI_SECRET=your_secret \
  leadstream-voice
```

The Dockerfile uses a multi-stage build:
- **Stage 1 (builder):** compiles TypeScript → `dist/`
- **Stage 2 (production):** copies only compiled JS + prod dependencies; final image ~180 MB

### Render (recommended)

- [ ] Push repo to GitHub
- [ ] Create new **Web Service** on [Render](https://render.com) → connect repo
- [ ] Set env vars in Render dashboard: `GROQ_API_KEY`, `VAPI_SECRET`, `PORT=3000`
- [ ] Render auto-detects Dockerfile and builds
- [ ] Copy your public Render URL (e.g. `https://leadstream-voice.onrender.com`)
- [ ] Update VAPI Server URL to `https://leadstream-voice.onrender.com/vapi/webhook`
- [ ] Place an end-to-end test call

---

## WebSocket Events

The server broadcasts events over WebSocket to all connected dashboard clients. Each event has this shape:

```json
{
  "callId": "vapi_abc123",
  "type": "TURN",
  "data": { ... },
  "ts": 1713000000000
}
```

| Event type | Trigger | Payload fields |
|---|---|---|
| `CALL_STARTED` | `assistant-request` received | `firstMessage`, `ts` |
| `TURN` | Successful tool-call routing | `transcript`, `response`, `fromState`, `toState`, `redlined` |
| `REDLINE` | Redline keyword detected | same as `TURN` with `redlined: true` |
| `BOT_RESPONSE` | After every routed turn | `transcript` (bot text), `state` |
| `CALL_ENDED` | `end-of-call-report` processed | `lead` (LeadPayload), `summary` |

Event history is held in-memory (`getEventStore()`) and also available via `GET /api/events` for clients that connect after a call started.

---

## Security

| Control | Implementation |
|---|---|
| Webhook authentication | `x-vapi-secret` header compared against `VAPI_SECRET` env var on every request |
| Rate limiting | 100 requests / 15-minute window per IP on `/vapi/webhook` via `express-rate-limit` |
| Tool-call deduplication | `processedToolCalls` Set prevents replay of the same `toolCallId` |
| Session expiry | Safety reaper timer auto-purges sessions after 1 hour |
| Trust proxy | `app.set('trust proxy', 1)` ensures correct IP detection behind Render/Nginx |
| No secrets in repo | `.env` is git-ignored; `.env.example` never contains values |

---

## Production Roadmap

The current architecture is intentionally designed so each of the following is a **drop-in swap**, not a structural change:

| Current (MVP) | Production upgrade |
|---|---|
| In-memory `callStateMap` | Redis (multi-instance safe) |
| `logs/<callId>.json` on disk | PostgreSQL / DynamoDB |
| `crmMock.ts` console output | HubSpot API via queue (BullMQ + Redis) |
| `[WHATSAPP_API]` log line | Twilio WhatsApp Business API |
| Ngrok tunnel | Render with custom domain + SSL |
| Single-server WebSocket | Socket.io with Redis adapter |

---

## License

ISC

---

*Built on [VAPI](https://vapi.ai) · [Groq](https://groq.com) · [Node.js](https://nodejs.org)*
