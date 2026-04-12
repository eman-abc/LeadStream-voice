"use strict";

/**
 * CallState — all possible states in the Evolve voice agent state machine.
 *
 * Flow:
 *   GREETING → INFO_SEARCH (product questions)
 *            → DATA_COLLECTION (ready to book)
 *   INFO_SEARCH → INFO_SEARCH (more questions)
 *              → DATA_COLLECTION (ready to book)
 *   DATA_COLLECTION → CONFIRM_CLOSE (details received)
 *                   → DATA_COLLECTION (asked another question mid-booking)
 *   CONFIRM_CLOSE → END_CALL (said goodbye / no more questions)
 *                → CONFIRM_CLOSE (still has questions)
 *   REDLINE → REDLINE (still on sensitive topic)
 *           → INFO_SEARCH (pivoted to valid question)
 *   END_CALL → END_CALL (terminal)
 */
const CallState = {
    GREETING:        "GREETING",
    INFO_SEARCH:     "INFO_SEARCH",
    DATA_COLLECTION: "DATA_COLLECTION",
    CONFIRM_CLOSE:   "CONFIRM_CLOSE",
    REDLINE:         "REDLINE",
    END_CALL:        "END_CALL",
};

module.exports = { CallState };