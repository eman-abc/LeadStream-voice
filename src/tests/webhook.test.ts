"use strict";

const request = require("supertest");

// Import the Express app — NOT server.listen(), just the app instance.
// This requires server.ts to export the app object. Add this to server.ts
// if not already present: module.exports = { app };

let app;

beforeAll(() => {
    app = require("../../src/server").app;
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
                .send({ message: { type: eventType } })
                .expect(200);
            expect(res.body).toEqual({ received: true });
        });
    });
});

describe("POST /vapi/webhook — tool-calls", () => {
    it("returns results array with toolCallId for clean query", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
            .send({
                message: {
                    type: "tool-calls",
                    call: { id: "test-call-001" },
                    toolCallList: [{
                        id: "tc-abc-123",
                        function: {
                            name: "route_message",
                            arguments: { transcript: "Tell me about DinoScan" }
                        }
                    }]
                }
            })
            .expect(200);

        expect(res.body.results).toBeDefined();
        expect(Array.isArray(res.body.results)).toBe(true);
        expect(res.body.results[0].toolCallId).toBe("tc-abc-123");
        expect(typeof res.body.results[0].result).toBe("string");
        expect(res.body.results[0].result.length).toBeGreaterThan(0);
    });

    it("returns redline response for sensitive keyword", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
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
            .expect(200);

        expect(res.body.results[0].result).toMatch(/not able to discuss/i);
    });

    it("handles missing transcript gracefully", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
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
            .expect(200);

        expect(res.body.results).toBeDefined();
        expect(typeof res.body.results[0].result).toBe("string");
    });
});

describe("POST /vapi/webhook — end-of-call-report", () => {
    it("returns received: true and does not crash", async () => {
        const res = await request(app)
            .post("/vapi/webhook")
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
