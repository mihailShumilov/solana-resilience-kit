/**
 * SPEC (red until implemented): HTTP status extraction must work for EVERY
 * error shape the pool actually sees (issue #16).
 *
 * `@solana/kit`'s own HTTP transport — the one the README tells you to plug in
 * via `createDefaultRpcTransport` — throws a `SolanaError` that carries the
 * status under `context.statusCode`, NOT at the top level. Reading only the
 * top-level field means `isRateLimited()` is false for every real 429, so
 * `Metrics.recordRateLimited` reads zero exactly when a provider is throttling
 * you. The harness's `HttpTransportError` sets the top-level field, which is
 * why the suite passed while production was blind.
 */
import { describe, it, expect } from "vitest";
import { httpStatusOf, isRateLimited, retryAfterMs } from "../../src/rpc/http-status.js";
import { HttpTransportError } from "../harness/faults.js";

/** The exact shape `@solana/kit` v6 throws for an HTTP error (verified). */
function kitHttpError(statusCode: number, headers: Record<string, string> = {}): Error {
  const err = new Error(`HTTP error (${statusCode}): whatever`) as Error & {
    context: Record<string, unknown>;
  };
  err.name = "SolanaError";
  err.context = { __code: 8100002, headers, message: "Too Many Requests", statusCode };
  return err;
}

describe("httpStatusOf (issue #16)", () => {
  it("reads a top-level statusCode (harness / gateway-style errors)", () => {
    expect(httpStatusOf(new HttpTransportError(429, "rate limited"))).toBe(429);
    expect(httpStatusOf(new HttpTransportError(503, "unavailable"))).toBe(503);
  });

  it("reads a kit SolanaError's context.statusCode", () => {
    expect(httpStatusOf(kitHttpError(429))).toBe(429);
    expect(httpStatusOf(kitHttpError(500))).toBe(500);
  });

  it("reads a fetch-style response.status", () => {
    expect(httpStatusOf({ response: { status: 429 } })).toBe(429);
  });

  it("reads a top-level status and a response.statusCode", () => {
    expect(httpStatusOf({ status: 503 })).toBe(503);
    expect(httpStatusOf({ response: { statusCode: 429 } })).toBe(429);
  });

  it("ignores non-object context / response slots", () => {
    expect(httpStatusOf({ context: null, response: null })).toBeUndefined();
    expect(httpStatusOf({ context: "nope", response: 7 })).toBeUndefined();
    expect(httpStatusOf({ context: {}, response: {} })).toBeUndefined();
  });

  it("returns undefined for shapes that carry no status", () => {
    expect(httpStatusOf(null)).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
    expect(httpStatusOf("429")).toBeUndefined();
    expect(httpStatusOf(new Error("boom"))).toBeUndefined();
    expect(httpStatusOf({ statusCode: "429" })).toBeUndefined();
    expect(httpStatusOf({ context: { statusCode: "429" } })).toBeUndefined();
  });
});

describe("isRateLimited (issue #16)", () => {
  it("is true for a 429 wherever the layer put it", () => {
    expect(isRateLimited(new HttpTransportError(429))).toBe(true);
    expect(isRateLimited(kitHttpError(429))).toBe(true);
    expect(isRateLimited({ response: { status: 429 } })).toBe(true);
  });

  it("is false for any other status and for statusless errors", () => {
    expect(isRateLimited(new HttpTransportError(503))).toBe(false);
    expect(isRateLimited(kitHttpError(500))).toBe(false);
    expect(isRateLimited(new Error("connection reset"))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe("retryAfterMs (provider back-off hint)", () => {
  it("reads a delay-seconds Retry-After from context headers", () => {
    expect(retryAfterMs(kitHttpError(429, { "retry-after": "7" }))).toBe(7_000);
  });

  it("reads a top-level headers bag case-insensitively", () => {
    expect(retryAfterMs({ statusCode: 429, headers: { "Retry-After": "2" } })).toBe(2_000);
  });

  it("reads a response headers bag", () => {
    expect(retryAfterMs({ response: { status: 429, headers: { "retry-after": "3" } } })).toBe(3_000);
  });

  it("ignores header bags that are not plain objects", () => {
    expect(retryAfterMs({ headers: ["retry-after", "5"] })).toBeUndefined();
    expect(retryAfterMs({ headers: null, context: { headers: { "retry-after": "1" } } })).toBe(1_000);
  });

  it("ignores a negative or non-retry-after header", () => {
    expect(retryAfterMs({ headers: { "retry-after": "-1" } })).toBeUndefined();
    expect(retryAfterMs({ headers: { "x-ratelimit-reset": "10" } })).toBeUndefined();
  });

  it("returns undefined when no usable hint is present", () => {
    expect(retryAfterMs(kitHttpError(429))).toBeUndefined();
    expect(retryAfterMs(new HttpTransportError(429))).toBeUndefined();
    expect(retryAfterMs({ headers: { "retry-after": "not-a-number" } })).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});
