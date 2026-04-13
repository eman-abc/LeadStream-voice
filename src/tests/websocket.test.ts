"use strict";

require("dotenv").config();
const request = require("supertest");
const WebSocket = require("ws");
const { app, httpServer, ready } = require("../../src/server");

let wsClient;
let port;
let receivedMessages = [];

beforeAll((done) => {
    ready.then(() => {
        httpServer.listen(0, () => {
            port = httpServer.address().port;
            done();
        });
    }).catch(done);
});

afterAll((done) => {
    if (wsClient) {
        wsClient.once("close", () => httpServer.close(done));
        wsClient.close();
        return;
    }
    httpServer.close(done);
});

describe("WebSocket Dashboard Integration", () => {
    it("connects the mock WS client and receives HISTORY", (done) => {
        wsClient = new WebSocket(`ws://localhost:${port}`);
        
        wsClient.on("message", (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                // The first message upon connect should be HISTORY
                if (parsed.type === "HISTORY") {
                    expect(Array.isArray(parsed.events)).toBe(true);
                    done(); 
                } else {
                    receivedMessages.push(parsed);
                }
            } catch (err) {
                console.error("Failed to parse WS msg", err);
            }
        });
        
        wsClient.on("error", (err) => {
            console.error("WS error: ", err);
        });
    });

    it("simulates assistant-request and receives CALL_STARTED via WS", async () => {
        const callId = "test-call-ws-123";
        // Clear previous messages
        receivedMessages = [];
        
        const payload = {
            message: {
                type: "assistant-request",
                call: { id: callId }
            }
        };

        await request(app)
            .post("/vapi/webhook")
            .set("x-vapi-secret", process.env.VAPI_SECRET || "")
            .send(payload)
            .expect(200);
            
        // Give the WebSocket a tiny window to receive the broadcasted event
        await new Promise(r => setTimeout(r, 100));

        const eventMsgs = receivedMessages.filter(m => m.type === "EVENT");
        expect(eventMsgs.length).toBeGreaterThan(0);
        
        const latestEvent = eventMsgs[eventMsgs.length - 1].event;
        expect(latestEvent.type).toBe("CALL_STARTED");
        expect(latestEvent.callId).toBe(callId);
    });

    it("simulates tool-calls turn and receives TURN via WS", async () => {
        const callId = "test-call-ws-123";
        receivedMessages = [];

        const payload = {
            message: {
                type: "tool-calls",
                call: { id: callId },
                toolCallList: [{
                    id: "tc-test-1",
                    function: {
                        name: "route_message",
                        arguments: {
                            transcript: "I want to book a demo"
                        }
                    }
                }]
            }
        };

        await request(app)
            .post("/vapi/webhook")
            .set("x-vapi-secret", process.env.VAPI_SECRET || "")
            .send(payload)
            .expect(202);

        await new Promise(r => setTimeout(r, 150));

        const eventMsgs = receivedMessages.filter(m => m.type === "EVENT");
        // We now emit BOT_RESPONSE as well, so there should be 2 events here.
        expect(eventMsgs.length).toBeGreaterThanOrEqual(1);
        
        const turnEvent = eventMsgs.find(m => m.event.type === "TURN")?.event;
        expect(turnEvent).toBeDefined();
        expect(turnEvent.callId).toBe(callId);
        expect(turnEvent.data.transcript).toBe("I want to book a demo");
    });

    it("simulates end-of-call-report and receives CALL_ENDED with lead data via WS", async () => {
        const callId = "test-call-ws-123";
        receivedMessages = [];

        const payload = {
            message: {
                type: "end-of-call-report",
                call: { id: callId },
                artifact: {
                    messages: [
                        { role: "user", message: "I want to book a demo. My email is sarah@techcorp.com" }
                    ]
                }
            }
        };

        await request(app)
            .post("/vapi/webhook")
            .set("x-vapi-secret", process.env.VAPI_SECRET || "")
            .send(payload)
            .expect(200);

        await new Promise(r => setTimeout(r, 150));

        const eventMsgs = receivedMessages.filter(m => m.type === "EVENT");
        // Depending on timing, you might get HISTORY replays or other streams natively, but we cleared the arr.
        expect(eventMsgs.length).toBeGreaterThanOrEqual(1);
        
        const endEvent = eventMsgs[eventMsgs.length - 1].event;
        expect(endEvent.type).toBe("CALL_ENDED");
        expect(endEvent.callId).toBe(callId);
        
        // Assert the lead data was extracted and pushed correctly
        expect(endEvent.data.lead).toBeDefined();
        expect(endEvent.data.lead.intent).toBe("demo_request");
        expect(endEvent.data.lead.customer.email).toBe("sarah@techcorp.com");
    });
});
