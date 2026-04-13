# CVision Voice Triage Platform — Architecture

> **Project:** `cvision-triage-native`  
> **Role target:** Full-Stack AI Engineer, CVision  
> **Core principle:** Native TypeScript state machine over framework wrappers. No LangChain. No LangGraph. Every routing decision is a typed enum transition you can trace in a debugger.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Directory Structure](#2-directory-structure)
3. [Data Contracts](#3-data-contracts)
4. [Phase A — Real-Time Call Routing](#4-phase-a--real-time-call-routing)
5. [Phase B — Async Post-Call Pipeline](#5-phase-b--async-post-call-pipeline)
6. [State Machine Logic](#6-state-machine-logic)
7. [File-by-File Responsibilities](#7-file-by-file-responsibilities)
8. [Environment & Configuration](#8-environment--configuration)
9. [Deployment](#9-deployment)
10. [Build Order](#10-build-order)
11. [Interview Talking Points](#11-interview-talking-points)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      PHASE A (real-time)                    │
│                                                             │
│  Caller ──► VAPI ──► POST /vapi/webhook ──► router.ts      │
│              ▲         (tool-call event)      │             │
│              │                                ▼             │
│              └──── response text ◄── switch(CallState)     │
│                                         │         │         │
│                                    Groq LLM   Hardcoded    │
│                                   + JSON KB    Redline      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     PHASE B (async)                         │
│                                                             │
│  VAPI end-of-call-report ──► POST /vapi/end-of-call        │
│                                      │                      │
│                               leadParser.ts                 │
│                                      │                      │
│                               LeadPayload{}                 │
│                                      │                      │
│                              crmMock.ts                     │
│                            ┌─────────┴──────────┐          │
│                       [CRM_SYNC]          [WHATSAPP_API]   │
│                      console log           console log     │
└─────────────────────────────────────────────────────────────┘
```

**Tech stack at a glance:**

| Layer | Tool | Why |
|---|---|---|
| Telephony | VAPI | Handles WebRTC, Deepgram STT, ElevenLabs TTS |
| Server | Node.js + Express + TypeScript | CVision's standard backend |
| Inference | Groq SDK (Llama-3-8b-8192) | Sub-200ms TTFT, no LangChain overhead |
| State machine | Native TypeScript enums + switch | Deterministic, zero dependencies, debuggable |
| Knowledge base | Local `knowledge.json` | Zero-latency lookup, no vector DB needed |
| Deployment | Docker → Render | Public URL for VAPI webhook |
| Local tunnel | Ngrok | Webhook testing before Render deploy |

---

## 2. Directory Structure

```
cvision-triage-native/
├── .env                          # GROQ_API_KEY, PORT, VAPI_SECRET
├── .env.example                  # Committed — shows required keys, no values
├── .gitignore
├── Dockerfile                    # Multi-stage build
├── docker-compose.yml            # Local dev shortcut
├── package.json
├── tsconfig.json
└── src/
    ├── server.ts                 # Express init, route mounting
    ├── types/
    │   └── index.ts              # CallState enum + LeadPayload interface
    ├── controllers/
    │   └── vapiController.ts     # Thin — catches webhooks, calls services
    ├── state-machine/
    │   ├── router.ts             # switch(state) — THE brain
    │   └── actions.ts            # Groq SDK call, prompt assembly
    ├── services/
    │   ├── callSessionStore.ts   # Redis-backed per-call state store
    │   ├── leadParser.ts         # Extracts typed fields from VAPI transcript
    │   └── crmMock.ts            # Console-formatted CRM + WhatsApp simulation
    └── data/
        └── knowledge.json        # dino Software FAQ, pricing, redline triggers
```

**Why this structure matters:** Each file has exactly one job. `vapiController.ts` never calls Groq directly. `router.ts` never touches the HTTP request object. This is the separation that makes the codebase walkable in a 30-minute interview.

---

## 3. Data Contracts

These are the two types the entire system is built around. Define these first, before writing any logic.

### `src/types/index.ts`

```typescript
// The only states the AI is allowed to occupy.
// If a transition isn't defined here, it cannot happen.
export enum CallState {
  GREETING       = "GREETING",        // Entry point — route the caller's intent
  INFO_SEARCH    = "INFO_SEARCH",     // Answer product/pricing questions via Groq + KB
  DATA_COLLECTION = "DATA_COLLECTION", // Collect name, email, intent for lead
  REDLINE        = "REDLINE",         // Hard stop — LLM bypassed, hardcoded refusal
  END_CALL       = "END_CALL",        // Terminal state — emit LeadPayload
}

// The structured business value delivered after every call.
// This is what would POST to HubSpot in production.
export interface LeadPayload {
  callId: string;
  timestamp: string;                  // ISO 8601
  customer: {
    name: string;
    email: string;
  };
  intent: "demo_request"             // Caller wants a product demo
        | "pricing_inquiry"          // Caller asking about cost
        | "general_inquiry"          // Catch-all for non-specific calls
        | "unqualified";             // Caller not a fit or incomplete data
  summary: string;                   // 1–2 sentence call summary
  redlineFlagged: boolean;           // True if any sensitive keyword was detected
}
```

### `src/data/knowledge.json`

```json
{
  "company": "dino Software",
  "product": "B2B SaaS workflow automation platform",
  "pricing": {
    "starter": "$299/month — up to 5 users, core automation features",
    "growth": "$799/month — up to 25 users, API access, priority support",
    "enterprise": "Custom pricing — unlimited users, dedicated CSM, SLA guarantees"
  },
  "features": [
    "No-code workflow builder",
    "Native integrations with HubSpot, Slack, and Jira",
    "Role-based access control",
    "Audit logs and compliance exports"
  ],
  "demo": "Book at dino.software/demo — 30-minute live walkthrough with a product specialist",
  "support": "support@dinosoftware.com — response within 4 business hours",
  "redline_topics": [
    "investor",
    "funding",
    "discount",
    "competitor",
    "salary",
    "lawsuit",
    "acquisition",
    "revenue"
  ]
}
```

---

## 4. Phase A — Real-Time Call Routing

### How a single turn works

```
1. Caller speaks
        │
        ▼
2. Deepgram (via VAPI) transcribes to text
        │
        ▼
3. VAPI sends tool-call POST to POST /vapi/webhook
   Body: { transcript: string, callId: string, ... }
        │
        ▼
4. vapiController.ts receives request
   - Reads current CallState from Redis (`call:{callId}:state`)
   - Loads entities/history from Redis (`call:{callId}:entities`, `call:{callId}:history`)
   - Calls router.ts with (state, transcript)
        │
        ▼
5. router.ts evaluates
   ┌─── REDLINE keyword found? ──────────────► Return hardcoded refusal (no LLM)
   │
   └─── No redline → switch(state)
         GREETING        → Return routing prompt
         INFO_SEARCH     → queryGroq(transcript, knowledge.json) → return answer
         DATA_COLLECTION → Return data-collection prompt
         END_CALL        → Return closing script
        │
        ▼
6. vapiController.ts returns { result: responseText } to VAPI
        │
        ▼
7. ElevenLabs (via VAPI) speaks the response to the caller
```

### Latency target

| Segment | Budget |
|---|---|
| Deepgram STT | ~200ms |
| Network + Express handler | ~50ms |
| Groq Llama-3 TTFT | ~200ms |
| ElevenLabs TTS start | ~200ms |
| **Total** | **< 700ms** |

Redline responses skip Groq entirely — those return in under 100ms total.

### State transitions

```
                ┌──────────────────────────────────────┐
                │  Any state + redline keyword detected │
                └──────────────────┬───────────────────┘
                                   │
                                   ▼
GREETING ──► INFO_SEARCH ──► DATA_COLLECTION ──► END_CALL
                                                     ▲
                              REDLINE ───────────────┘
                           (after deflection)
```

Transitions are driven by intent keywords extracted from the transcript in `router.ts`. There is no ML classifier — just string matching on a short keyword list. Intentionally simple.

---

## 5. Phase B — Async Post-Call Pipeline

Triggered by VAPI's `end-of-call-report` webhook. Fires after the caller hangs up.

```
POST /vapi/end-of-call
Body: {
  callId: string,
  summary: string,          // VAPI-generated call summary
  transcript: string,       // Full conversation text
  startedAt: string,
  endedAt: string,
}
        │
        ▼
leadParser.ts
  - Regex/keyword extract: customer name, email
  - Intent classification: match against known intents
  - Check redlineFlagged: was REDLINE state reached?
  - Returns: LeadPayload
        │
        ▼
crmMock.ts
  - dispatchLead(payload: LeadPayload)
  - Prints [CRM_SYNC] block → simulates HubSpot POST /leads
  - Prints [WHATSAPP_API] block → simulates owner alert
  - Prints [REDLINE] warning if flagged
```

### Example console output

```
──────────────────────────────────────────────────
[CRM_SYNC]     POST /leads → 200 OK
               callId:  vapi_abc123
               name:    Sarah Chen
               email:   sarah@techcorp.io
               intent:  demo_request
               summary: Caller asked about Growth plan pricing and
                        requested a product demo for a 12-person team.

[WHATSAPP_API] Alert → +92300XXXXXXX
               "New lead: Sarah Chen wants a demo_request"

──────────────────────────────────────────────────
```

If `redlineFlagged: true`:

```
[REDLINE]      ⚠ Sensitive topic detected — review transcript
```

---

## 6. State Machine Logic

### `src/state-machine/router.ts`

```typescript
import { CallState } from '../types';
import { queryGroq } from './actions';
import knowledge from '../data/knowledge.json';

const REDLINE_KEYWORDS: string[] = knowledge.redline_topics;

export async function route(
  state: CallState,
  transcript: string,
  callId: string
): Promise<{ response: string; nextState: CallState; redlined: boolean }> {

  const lower = transcript.toLowerCase();

  // REDLINE check runs BEFORE the switch — LLM is never called
  if (REDLINE_KEYWORDS.some(k => lower.includes(k))) {
    return {
      response: "I appreciate you asking, but that's something I'm not able to discuss. "
              + "I'd be happy to help with product information or schedule a demo instead.",
      nextState: CallState.END_CALL,
      redlined: true,
    };
  }

  switch (state) {
    case CallState.GREETING:
      return {
        response: "Welcome to dino Software. I can help with product information, "
                + "pricing, or booking a demo. What brings you in today?",
        nextState: detectIntent(transcript),
        redlined: false,
      };

    case CallState.INFO_SEARCH:
      const answer = await queryGroq(transcript, knowledge);
      return {
        response: answer,
        nextState: CallState.DATA_COLLECTION,
        redlined: false,
      };

    case CallState.DATA_COLLECTION:
      return {
        response: "Before I let you go — could I grab your name and email "
                + "so our team can follow up with the details?",
        nextState: CallState.END_CALL,
        redlined: false,
      };

    case CallState.END_CALL:
      return {
        response: "Thanks so much for calling dino Software. We'll be in touch soon.",
        nextState: CallState.END_CALL,
        redlined: false,
      };

    default:
      return {
        response: "Let me connect you with the right information. One moment.",
        nextState: CallState.INFO_SEARCH,
        redlined: false,
      };
  }
}

function detectIntent(transcript: string): CallState {
  const t = transcript.toLowerCase();
  if (t.includes('demo') || t.includes('trial') || t.includes('try'))
    return CallState.DATA_COLLECTION;
  if (t.includes('price') || t.includes('cost') || t.includes('plan'))
    return CallState.INFO_SEARCH;
  return CallState.INFO_SEARCH; // default — answer the question first
}
```

### `src/state-machine/actions.ts`

```typescript
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function queryGroq(
  userQuery: string,
  knowledgeBase: object
): Promise<string> {
  const completion = await groq.chat.completions.create({
    model: 'llama3-8b-8192',
    messages: [
      {
        role: 'system',
        content: `You are a professional receptionist for dino Software. 
Answer only using the knowledge base below. 
Be concise — this is a phone call. Max 2 sentences.
If the answer is not in the knowledge base, say you will have a specialist follow up.

KNOWLEDGE BASE:
${JSON.stringify(knowledgeBase, null, 2)}`,
      },
      {
        role: 'user',
        content: userQuery,
      },
    ],
    max_tokens: 150,
    temperature: 0.3,  // Low temperature = consistent, on-script responses
  });

  return completion.choices[0]?.message?.content
    ?? "Let me have a specialist follow up with you on that.";
}
```

---

## 7. File-by-File Responsibilities

| File | Single responsibility | Calls | Never calls |
|---|---|---|---|
| `server.ts` | Express init, mount routes | — | Business logic |
| `vapiController.ts` | Parse VAPI webhook, orchestrate Redis-backed call session state | `router.ts`, `leadParser.ts`, `crmMock.ts`, `callSessionStore.ts` | Groq, knowledge.json |
| `router.ts` | Evaluate state + transcript → response + nextState | `actions.ts` | HTTP layer |
| `actions.ts` | Groq API call + prompt assembly | Groq SDK | State machine |
| `leadParser.ts` | Extract typed fields from raw VAPI report | — | Groq, router |
| `crmMock.ts` | Format and print CRM/WhatsApp simulation | — | Everything else |
| `types/index.ts` | Type definitions only | — | Everything |
| `data/knowledge.json` | Static data only | — | Everything |

---

## 8. Environment & Configuration

### `.env` (git-ignored)

```bash
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
VAPI_SECRET=optional_webhook_secret_for_validation
REDIS_URL=redis://localhost:6379
```

### `.env.example` (committed)

```bash
GROQ_API_KEY=
PORT=3000
VAPI_SECRET=
REDIS_URL=redis://localhost:6379
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### `package.json` (key scripts)

```json
{
  "scripts": {
    "dev": "ts-node-dev --respawn src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "tunnel": "ngrok http 3000"
  },
  "dependencies": {
    "express": "^4.18.2",
    "groq-sdk": "^0.3.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "ts-node-dev": "^2.0.0",
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0"
  }
}
```

---

## 9. Deployment

### `Dockerfile`

```dockerfile
# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: production image
FROM node:20-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/data ./dist/data
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### `docker-compose.yml` (local dev)

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./src:/app/src
```

### Render deployment checklist

- [ ] Push repo to GitHub
- [ ] Create new Web Service on Render, connect repo
- [ ] Set env vars (`GROQ_API_KEY`, `PORT=3000`) in Render dashboard
- [ ] Render auto-detects Dockerfile and builds
- [ ] Copy public Render URL
- [ ] Set as VAPI webhook URL: `https://your-app.onrender.com/vapi/webhook`
- [ ] Set end-of-call webhook: `https://your-app.onrender.com/vapi/end-of-call`

### Local webhook testing with Ngrok

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run tunnel
# Copy the https URL from Ngrok output
# Paste into VAPI dashboard as webhook URL
```

---

## 10. Build Order

Follow this sequence. Each step is independently testable. Do not proceed until the current step works.

```
Step 1 — Scaffold & verify webhook receipt
  ✓ npm init, install deps, tsconfig
  ✓ server.ts: POST /vapi/webhook → console.log(req.body) → res.json({ result: "ok" })
  ✓ Ngrok tunnel running
  ✓ VAPI dashboard: webhook URL set, test call placed
  ✓ Confirm req.body appears in terminal

Step 2 — Wire state machine with hardcoded responses
  ✓ types/index.ts: CallState enum + LeadPayload interface
  ✓ router.ts: switch returning hardcoded strings
  ✓ vapiController.ts: reads state, calls router, returns { result }
  ✓ VAPI talks back on call

Step 3 — Add REDLINE detection
  ✓ REDLINE_KEYWORDS array in router.ts
  ✓ Keyword check runs before switch
  ✓ Test: say "investor" on a call → hardcoded refusal returned, no Groq called
  ✓ Confirm in logs: Groq was NOT invoked

Step 4 — Add Groq + knowledge.json
  ✓ actions.ts: queryGroq() implemented
  ✓ knowledge.json populated with dino Software data
  ✓ INFO_SEARCH case calls queryGroq
  ✓ Test: ask "what is the pricing?" → real answer from KB

Step 5 — Wire post-call pipeline
  ✓ POST /vapi/end-of-call endpoint in server.ts
  ✓ leadParser.ts extracts name, email, intent from report
  ✓ crmMock.ts dispatchLead() prints formatted output
  ✓ Test: complete a call → confirm console output appears

Step 6 — Docker + Render deploy
  ✓ Dockerfile builds without errors locally
  ✓ docker build -t cvision-triage . && docker run -p 3000:3000 cvision-triage
  ✓ Push to GitHub → Render deploys
  ✓ Update VAPI webhook URLs to Render public URL
  ✓ End-to-end test on live URL
```

---

## 11. Interview Talking Points

These are the architectural decisions worth explaining if Faras asks "why did you build it this way?"

**Why no LangGraph / LangChain?**
> "The state machine has five states and one non-linear transition — REDLINE. A graph framework would add 40KB of dependency for a problem a switch statement solves in 30 lines. I can trace every decision in a debugger. I can't do that with an opaque agent loop."

**Why does REDLINE check run before the switch?**
> "Because the switch might route to INFO_SEARCH, which calls Groq. If a redline keyword triggers the LLM before I intercept it, I've already lost control. The keyword check is a gate — nothing downstream runs until it clears."

**Why Groq over OpenAI for this use case?**
> "Time-to-first-token. On a phone call, 600ms of silence feels like a dropped line. Groq's Llama-3 TTFT is consistently under 200ms. OpenAI GPT-4o averages 400–600ms. On voice, that's the difference between a natural conversation and an awkward pause."

**Why local JSON instead of a vector database?**
> "The knowledge base is 15 static facts about one product. Embedding search adds 100ms of latency and a Pinecone dependency for a retrieval problem that a JSON lookup solves in zero milliseconds. I'd introduce a vector DB when the KB exceeds ~200 documents."

**Why multi-stage Docker build?**
> "The builder stage compiles TypeScript. The production stage copies only the compiled JS and production dependencies — no `devDependencies`, no source files, no TypeScript compiler. The final image is about 180MB instead of 600MB."

**What would you add in production?**
> "We already moved live call session state into Redis with TTL-backed keys, so the app is stateless across deploys and horizontal scaling. The next production swaps are mock CRM logs → real HubSpot API via a queue, console WhatsApp → Twilio WhatsApp Business API, and Ngrok → Render with a custom domain and SSL termination."
