"use strict";

require("dotenv").config();

const { handleRouting } = require("../../src/state-machine/router");
const { CallState } = require("../../src/types");

describe("State machine — REDLINE gate", () => {
    const REDLINE_WORDS = ["investor", "salary", "discount", "competitor", "funding"];

    REDLINE_WORDS.forEach(word => {
        it(`blocks "${word}" regardless of current state`, async () => {
            const result = await handleRouting(
                `Tell me about your ${word} situation`,
                CallState.GREETING
            );
            expect(result.redlined).toBe(true);
            expect(result.nextState).toBe(CallState.REDLINE);
            expect(result.content).toMatch(/not able to discuss/i);
        });
    });

    it("does not redline a clean greeting", async () => {
        const result = await handleRouting("Hello", CallState.GREETING);
        expect(result.redlined).toBe(false);
        expect(result.content).toMatch(/Dino Software/i);
    });

    it("transitions GREETING → INFO_SEARCH on product question", async () => {
        const result = await handleRouting(
            "Tell me about DinoScan",
            CallState.GREETING
        );
        expect(result.redlined).toBe(false);
        expect([CallState.INFO_SEARCH, CallState.DATA_COLLECTION])
            .toContain(result.nextState);
    });

    it("transitions GREETING → DATA_COLLECTION on demo request", async () => {
        const result = await handleRouting(
            "I want to book a demo",
            CallState.GREETING
        );
        expect(result.nextState).toBe(CallState.DATA_COLLECTION);
    });

    it("returns END_CALL response from END_CALL state", async () => {
        const result = await handleRouting("thanks bye", CallState.END_CALL);
        expect(result.nextState).toBe(CallState.END_CALL);
        expect(result.content).toMatch(/thank/i);
    });

    it("redline fires even mid-sentence with other content", async () => {
        const result = await handleRouting(
            "Can you tell me about your products and also your investor details",
            CallState.INFO_SEARCH
        );
        expect(result.redlined).toBe(true);
    });
});
