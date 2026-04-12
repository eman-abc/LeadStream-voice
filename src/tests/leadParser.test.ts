"use strict";

const { parseEndOfCallReport } = require("../../src/services/leadParser");

function makeReport(messages, callId = "test-call-123") {
    return {
        call: { id: callId },
        artifact: { messages }
    };
}

function userMsg(text) { return { role: "user", message: text }; }
function botMsg(text) { return { role: "bot", message: text }; }

describe("leadParser — name extraction", () => {
    it("extracts name from 'my name is X'", () => {
        const report = makeReport([userMsg("Hi, my name is Sarah Chen")]);
        const payload = parseEndOfCallReport(report);
        expect(payload.customer.name).toBe("Sarah Chen");
    });

    it("extracts name from 'I am X'", () => {
        const report = makeReport([userMsg("I am John Smith calling about your services")]);
        const payload = parseEndOfCallReport(report);
        expect(payload.customer.name).toBe("John Smith");
    });

    it("returns Unknown when no name found", () => {
        const report = makeReport([userMsg("Tell me about DinoScan")]);
        const payload = parseEndOfCallReport(report);
        expect(payload.customer.name).toBe("Unknown");
    });
});

describe("leadParser — email extraction", () => {
    it("extracts written email address", () => {
        const report = makeReport([userMsg("my email is sarah@techcorp.com")]);
        const payload = parseEndOfCallReport(report);
        expect(payload.customer.email).toBe("sarah@techcorp.com");
    });

    it("extracts spoken email: 'sarah dot chen at gmail dot com'", () => {
        const report = makeReport([
            userMsg("you can reach sarah dot chen at gmail dot com")
        ]);
        const payload = parseEndOfCallReport(report);
        expect(payload.customer.email).toBe("sarah.chen@gmail.com");
    });

    it("returns empty string when no email found", () => {
        const report = makeReport([userMsg("just call me back")]);
        const payload = parseEndOfCallReport(report);
        expect(payload.customer.email).toBe("");
    });
});

describe("leadParser — intent classification", () => {
    const cases = [
        { phrase: "I want to book a demo", expected: "demo_request" },
        { phrase: "can we schedule a trial", expected: "demo_request" },
        { phrase: "how much does it cost", expected: "pricing_inquiry" },
        { phrase: "what is the pricing", expected: "pricing_inquiry" },
        { phrase: "tell me about DinoScan", expected: "general_inquiry" },
        { phrase: "we have a COBOL system", expected: "general_inquiry" },
        { phrase: "just browsing", expected: "unqualified" },
    ];

    cases.forEach(({ phrase, expected }) => {
        it(`classifies "${phrase}" as ${expected}`, () => {
            const report = makeReport([userMsg(phrase)]);
            const payload = parseEndOfCallReport(report);
            expect(payload.intent).toBe(expected);
        });
    });
});

describe("leadParser — redline detection", () => {
    it("flags investor mention", () => {
        const report = makeReport([userMsg("what is your investor situation")]);
        const payload = parseEndOfCallReport(report);
        expect(payload.redlineFlagged).toBe(true);
    });

    it("does not flag a clean product inquiry", () => {
        const report = makeReport([userMsg("tell me about DinoMigrate pricing")]);
        const payload = parseEndOfCallReport(report);
        expect(payload.redlineFlagged).toBe(false);
    });
});

describe("leadParser — edge cases", () => {
    it("handles empty messages array", () => {
        const report = makeReport([]);
        const payload = parseEndOfCallReport(report);
        expect(payload.customer.name).toBe("Unknown");
        expect(payload.customer.email).toBe("");
        expect(payload.intent).toBe("unqualified");
        expect(payload.redlineFlagged).toBe(false);
    });

    it("handles completely missing artifact", () => {
        const payload = parseEndOfCallReport({ call: { id: "abc" } });
        expect(payload.callId).toBe("abc");
        expect(payload.customer.name).toBe("Unknown");
    });

    it("sets callId from report body", () => {
        const report = makeReport([userMsg("hello")], "call-xyz-999");
        const payload = parseEndOfCallReport(report);
        expect(payload.callId).toBe("call-xyz-999");
    });

    it("always returns ISO timestamp", () => {
        const report = makeReport([]);
        const payload = parseEndOfCallReport(report);
        expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
    });
});
