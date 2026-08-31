/**
 * SPEC (red until implemented): a Solana node reports being behind, or a block
 * being unavailable, as an HTTP 200 carrying a JSON-RPC `error` BODY (issue
 * #19). `@solana/kit`'s transport only throws on `!response.ok`, so that whole
 * failure class arrives as a resolved response and never reaches the pool's
 * catch block.
 *
 * `nodeStateError` is the body-layer twin of `httpStatusOf`: it decides whether
 * an error body says something about the NODE answering (failover-worthy) or
 * about the CALLER's request (every endpoint would repeat it, so blaming the
 * endpoint would be a worse bug than the one being fixed).
 */
import { describe, it, expect } from "vitest";
import { nodeStateError, isRateLimited } from "../../src/rpc/http-status.js";
import { RpcNodeStateError } from "../../src/errors.js";

const body = (code: number, message: string): unknown => ({
  jsonrpc: "2.0",
  id: 1,
  error: { code, message },
});

describe("nodeStateError — node-state codes (issue #19)", () => {
  it.each([
    [-32004, "Block not available for slot 123"],
    [-32005, "Node is unhealthy; behind by 1500 slots"],
    [-32007, "Slot 123 was skipped, or missing due to ledger jump to recent snapshot"],
    [-32009, "Slot 123 was skipped, or missing in long-term storage"],
    [-32011, "Transaction history is not available from this node"],
    [-32019, "Failed to query long-term storage; please try again"],
  ])("treats %i as the endpoint's problem", (code, message) => {
    const err = nodeStateError(body(code, message));
    expect(err).toBeInstanceOf(RpcNodeStateError);
    expect(err?.code).toBe(code);
    expect(err?.rpcMessage).toBe(message);
    expect(err?.message).toContain(String(code));
  });
});

describe("nodeStateError — caller faults must never blame the endpoint", () => {
  it.each([
    [-32700, "Parse error"],
    [-32600, "Invalid Request"],
    [-32601, "Method not found"],
    [-32602, "Invalid params: unsupported commitment"],
    [-32603, "Internal error"],
  ])("ignores %i", (code, message) => {
    expect(nodeStateError(body(code, message))).toBeUndefined();
  });

  it("ignores a caller fault even when its message mentions a rate limit", () => {
    // Otherwise one malformed request could eject a perfectly healthy provider.
    expect(nodeStateError(body(-32602, "Invalid params: rate limit field"))).toBeUndefined();
  });

  it("ignores Solana codes that describe the TRANSACTION, not the node", () => {
    // Failing over on these would just repeat the same result elsewhere.
    expect(nodeStateError(body(-32002, "Transaction simulation failed"))).toBeUndefined();
    expect(nodeStateError(body(-32003, "Transaction signature verification failure"))).toBeUndefined();
  });
});

describe("nodeStateError — rate limits reported in the body", () => {
  it("maps a 429 body code onto statusCode 429 so the existing breaker applies", () => {
    const err = nodeStateError(body(429, "Too Many Requests"));
    expect(err).toBeInstanceOf(RpcNodeStateError);
    expect(err?.statusCode).toBe(429);
    expect(isRateLimited(err)).toBe(true);
  });

  it("recognises rate-limit wording on a node-state code", () => {
    const err = nodeStateError(body(-32005, "Rate limit exceeded, please slow down"));
    expect(isRateLimited(err)).toBe(true);
  });

  it("does not mark an ordinary node-state error as rate-limited", () => {
    const err = nodeStateError(body(-32005, "Node is unhealthy; behind by 1500 slots"));
    expect(err?.statusCode).toBeUndefined();
    expect(isRateLimited(err)).toBe(false);
  });
});

describe("nodeStateError — shapes that are not error bodies", () => {
  it("returns undefined for a normal successful response", () => {
    expect(nodeStateError({ jsonrpc: "2.0", id: 1, result: 42n })).toBeUndefined();
    expect(nodeStateError({ jsonrpc: "2.0", id: 1, result: null })).toBeUndefined();
  });

  it("returns undefined for non-objects and malformed error members", () => {
    expect(nodeStateError(null)).toBeUndefined();
    expect(nodeStateError(undefined)).toBeUndefined();
    expect(nodeStateError("boom")).toBeUndefined();
    expect(nodeStateError({ error: null })).toBeUndefined();
    expect(nodeStateError({ error: "boom" })).toBeUndefined();
    expect(nodeStateError({ error: { message: "no code" } })).toBeUndefined();
    expect(nodeStateError({ error: { code: "-32005" } })).toBeUndefined();
  });

  it("tolerates a missing message on a node-state code", () => {
    const err = nodeStateError({ error: { code: -32005 } });
    expect(err).toBeInstanceOf(RpcNodeStateError);
    expect(err?.rpcMessage).toBe("");
  });
});
