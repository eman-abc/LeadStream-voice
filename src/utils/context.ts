"use strict";

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

export interface RequestContext {
    callId: string;
    traceId: string;
}

/**
 * The single, process-wide AsyncLocalStorage "bubble".
 * Each webhook request gets its own store entry; child async operations
 * (Groq calls, Redis reads, WebSocket pushes) inherit it automatically
 * because Node.js propagates AsyncLocalStorage across all awaited promises.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` inside a fresh context bubble.
 * @param callId  - The Vapi callId extracted from the webhook body.
 * @param fn      - The async work to execute within the bubble.
 */
export function runWithContext<T>(callId: string, fn: () => Promise<T>): Promise<T> {
    const ctx: RequestContext = { callId, traceId: randomUUID() };
    return requestContext.run(ctx, fn);
}

/**
 * Retrieve the current context or a safe fallback when called outside a bubble.
 */
export function getContext(): RequestContext {
    return requestContext.getStore() ?? { callId: "no-context", traceId: "no-trace" };
}
