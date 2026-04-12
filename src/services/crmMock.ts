"use strict";

/**
 * dispatchLead — formats and logs the lead payload as mock CRM + WhatsApp output.
 * This is the "Post-Call Value" proof artifact for the interview demo.
 * @param {import('./leadParser').LeadPayload} payload
 */
function dispatchLead(payload) {
    const LINE = "═".repeat(55);
    const now = new Date().toLocaleTimeString();

    console.log(`\n${LINE}`);
    console.log(`  POST-CALL LEAD CAPTURED  [${now}]`);
    console.log(LINE);

    console.log(`\n  [CRM_SYNC]     POST /api/leads → 200 OK`);
    console.log(`  ┌─────────────────────────────────────────┐`);
    console.log(`  │  callId  : ${payload.callId.slice(0, 30)}`);
    console.log(`  │  name    : ${payload.customer.name}`);
    console.log(`  │  email   : ${payload.customer.email || "(not captured)"}`);
    console.log(`  │  intent  : ${payload.intent}`);
    console.log(`  │  redline : ${payload.redlineFlagged ? "⚠ YES — review required" : "clean"}`);
    console.log(`  └─────────────────────────────────────────┘`);

    console.log(`\n  [WHATSAPP_API] Alerting owner → +92300XXXXXXX`);
    console.log(`  ┌─────────────────────────────────────────┐`);
    console.log(`  │  "New lead from Dino Software triage:"`);
    console.log(`  │  ${payload.customer.name} — ${payload.intent}`);

    if (payload.customer.email) {
        console.log(`  │  Contact: ${payload.customer.email}`);
    }
    if (payload.redlineFlagged) {
        console.log(`  │  ⚠ SENSITIVE TOPIC DETECTED ON THIS CALL`);
    }
    console.log(`  └─────────────────────────────────────────┘`);

    console.log(`\n  [SUMMARY]`);
    console.log(`  "${payload.summary.slice(0, 120)}..."`);
    console.log(`\n${LINE}\n`);
}

module.exports = { dispatchLead };
