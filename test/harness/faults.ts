/**
 * Fault model for a single simulated RPC endpoint. Every field is optional;
 * an empty profile is a perfectly healthy node. These map 1:1 to the real
 * failure modes documented in the problem analysis (drops, 429s, lag, etc.).
 */
export interface EndpointFaultProfile {
  /** Artificial latency in ms. A tuple draws uniformly in [min, max]. */
  latencyMs?: number | [number, number];
  /** Probability (0..1) a `sendTransaction` is silently dropped (never lands). */
  dropRate?: number;
  /** Probability (0..1) any request fails with a generic transport error. */
  errorRate?: number;
  /** Probability (0..1) any request fails with an HTTP 429 rate-limit error. */
  rate429Rate?: number;
  /** Slots this node lags behind cluster truth (models a stale/lagging node). */
  slotLag?: number;
  /**
   * Answer every request with a JSON-RPC error BODY over HTTP 200 — how a real
   * node reports "behind by N slots" or "block not available" (issue #19).
   * Distinct from the error faults above: nothing throws, the request
   * SUCCEEDS at the transport layer and the failure is in the payload.
   */
  jsonRpcError?: { code: number; message?: string };
  /** When true, every request rejects immediately (node down). */
  offline?: boolean;
}

/** Transport-level error carrying an HTTP-style status, like a provider gateway 429/5xx. */
export class HttpTransportError extends Error {
  constructor(
    readonly statusCode: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${statusCode}`);
    this.name = "HttpTransportError";
  }
}

/** A request that never produced a response (connection dropped / node offline). */
export class TransportDroppedError extends Error {
  constructor(message = "transport request dropped") {
    super(message);
    this.name = "TransportDroppedError";
  }
}
