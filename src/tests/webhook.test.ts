"use strict";

const request = require("supertest");

// Import the Express app — NOT server.listen(), just the app instance.
// This requires server.ts to export the app object. Add this to server.ts
// if not already present: module.exports = { app };

let app;
let ready;

beforeAll(async () => {
    const serverModule = require("../../src/server");
    app = serverModule.app;
    ready = serverModule.ready;
    await ready;
});

describe("POST /vapi/webhook — passthrough events", () => {
    const PASSTHROUGH = [
        "speech-update",
        "status-update", 
        "transcript",
        "conversation-update",
        "assistant.started",
    ];

    PASSTHROUGH.forEach(eventType => {
        it(`responds 200 immediately to ${eventType}`, async () => {
            const res = await request(app)
                .post("/vapi/webhook")
                .set("x-vapi-secret", "secure_assistant")
                .send({ message: { type: eventType } })
                .expect(200);
            expect(res.body).toEqual({ received: true });
        });
    });
});

describe("POST /vapi/webhook — tool-calls", () => {
    it("acks quickly and queues a clean query", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
            .set("x-vapi-secret", "secure_assistant")
            .send({
                message: {
                    type: "tool-calls",
                    call: { id: "test-call-001" },
                    toolCallList: [{
                        id: "tc-abc-123",
                        function: {
                            name: "route_message",
                            arguments: { transcript: "I want to book a demo" }
                        }
                    }]
                }
            })
            .expect(202);

        expect(res.body.received).toBe(true);
        expect(res.body.queued).toBe(true);
        expect(Array.isArray(res.body.results)).toBe(true);
        expect(res.body.results[0].toolCallId).toBe("tc-abc-123");
        expect(res.body.results[0].result).toBe("");
    });

    it("queues a redline request instead of blocking the webhook", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
            .set("x-vapi-secret", "secure_assistant")
            .send({
                message: {
                    type: "tool-calls",
                    call: { id: "test-call-002" },
                    toolCallList: [{
                        id: "tc-red-456",
                        function: {
                            name: "route_message",
                            arguments: { transcript: "What is your investor revenue?" }
                        }
                    }]
                }
            })
            .expect(202);

        expect(res.body.received).toBe(true);
        expect(res.body.queued).toBe(true);
        expect(res.body.results[0].result).toBe("");
    });

    it("queues even when the transcript is missing", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
            .set("x-vapi-secret", "secure_assistant")
            .send({
                message: {
                    type: "tool-calls",
                    call: { id: "test-call-003" },
                    toolCallList: [{
                        id: "tc-empty-789",
                        function: { name: "route_message", arguments: {} }
                    }]
                }
            })
            .expect(202);

        expect(res.body.received).toBe(true);
        expect(res.body.queued).toBe(true);
        expect(res.body.results[0].result).toBe("");
    });
});

describe("POST /vapi/webhook — end-of-call-report", () => {
    it("returns received: true and does not crash", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
            .set("x-vapi-secret", "secure_assistant")
            .send({
                message: {
                    type: "end-of-call-report",
                    call: { id: "test-call-eoc" },
                    artifact: {
                        messages: [
                            { role: "user", message: "My name is Test User" },
                            { role: "bot", message: "Welcome to Dino Software" },
                        ]
                    }
                }
            })
            .expect(200);

        expect(res.body).toEqual({ received: true });
    });
});
