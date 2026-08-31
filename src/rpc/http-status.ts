/**
 * HTTP status extraction across the error shapes this SDK actually meets.
 *
 * There is no single convention: the harness (and most provider gateways)
 * throw an error with a top-level `statusCode`, while `@solana/kit`'s own HTTP
 * transport — the one the README tells you to plug in via
 * `createDefaultRpcTransport` — throws a `SolanaError` carrying the status
 * under `context.statusCode`. Reading only the top-level field made
 * `isRateLimited()` false for every REAL 429, so `Metrics.recordRateLimited`
 * read zero exactly when a provider was throttling the app (issue #16).
 *
 * The same asymmetry exists one layer down. A node reporting "behind by N
 * slots" answers HTTP 200 with a JSON-RPC `error` BODY, which kit resolves
 * rather than throws — so {@link nodeStateError} is the body-layer twin of
 * {@link httpStatusOf} (issue #19).
 *
 * Pure and total: never throws, never does I/O.
 */
import { RpcNodeStateError } from "../errors.js";

/** Read an HTTP status off an error wherever the layer beneath us put it. */
export function httpStatusOf(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const e = err as {
    statusCode?: unknown;
    status?: unknown;
    context?: { statusCode?: unknown; status?: unknown } | null;
    response?: { status?: unknown; statusCode?: unknown } | null;
  };

  // Gateway / harness style: the status sits on the error itself.
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;

  // @solana/kit SolanaError style: `context: { __code, statusCode, headers }`.
  const ctx = e.context;
  if (ctx !== null && typeof ctx === "object") {
    if (typeof ctx.statusCode === "number") return ctx.statusCode;
    if (typeof ctx.status === "number") return ctx.status;
  }

  // fetch/axios style: the originating Response is attached.
  const res = e.response;
  if (res !== null && typeof res === "object") {
    if (typeof res.status === "number") return res.status;
    if (typeof res.statusCode === "number") return res.statusCode;
  }

  return undefined;
}

/** True when an error is an HTTP 429, whatever layer produced it. */
export function isRateLimited(err: unknown): boolean {
  return httpStatusOf(err) === 429;
}

/**
 * The provider's own back-off hint (`Retry-After`) in ms, when one survived the
 * transport. Only the delay-seconds form is honoured — an HTTP-date form is
 * clock-skew sensitive and not worth guessing on. Note that kit's default
 * transport currently drops response headers, so this is usually `undefined`;
 * it costs nothing and is strictly better than a guess when present.
 */
export function retryAfterMs(err: unknown): number | undefined {
  for (const bag of headerBags(err)) {
    for (const [key, value] of Object.entries(bag)) {
      if (key.toLowerCase() !== "retry-after") continue;
      const seconds = Number(typeof value === "string" ? value.trim() : value);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
  }
  return undefined;
}

/** Every plain-object header bag reachable on an error, most specific first. */
function headerBags(err: unknown): Array<Record<string, unknown>> {
  if (err === null || typeof err !== "object") return [];
  const e = err as Record<string, unknown>;
  const candidates = [
    e.headers,
    (e.context as Record<string, unknown> | undefined)?.headers,
    (e.response as Record<string, unknown> | undefined)?.headers,
  ];
  return candidates.filter(
    (c): c is Record<string, unknown> => c !== null && typeof c === "object" && !Array.isArray(c),
  );
}

/**
 * JSON-RPC codes that describe the NODE answering, not the request asked of
 * it. Every one of these is worth trying somewhere else: a lagging node, a
 * pruned block, or a node without the history the query needs. Deliberately an
 * ALLOWLIST — an unknown code is left alone rather than blamed on the endpoint.
 */
const NODE_STATE_CODES = new Set([
  -32004, // Block not available for slot
  -32005, // Node is unhealthy / behind by N slots
  -32007, // Slot skipped, or missing due to a ledger jump to a recent snapshot
  -32009, // Slot skipped, or missing in long-term storage
  -32011, // Transaction history is not available from this node
  -32019, // Failed to query long-term storage
]);

/**
 * Standard JSON-RPC faults that belong to the CALLER. Every endpoint repeats
 * them, so failing over just burns a second provider, and ejecting a healthy
 * one because a caller sent bad params would be a worse bug than #19 itself.
 */
const CLIENT_FAULT_CODES = new Set([-32700, -32600, -32601, -32602, -32603]);

/** Gateways that report throttling in the body rather than the status line. */
const RATE_LIMIT_TEXT = /rate.?limit|too many requests/i;

interface JsonRpcErrorMember {
  code: number;
  message: string;
}

/** The `error` member of a JSON-RPC response, when it is a well-formed one. */
function jsonRpcErrorOf(response: unknown): JsonRpcErrorMember | undefined {
  if (response === null || typeof response !== "object") return undefined;
  const member = (response as { error?: unknown }).error;
  if (member === null || typeof member !== "object") return undefined;
  const { code, message } = member as { code?: unknown; message?: unknown };
  if (typeof code !== "number") return undefined;
  return { code, message: typeof message === "string" ? message : "" };
}

/**
 * Inspect a RESOLVED transport response for an error body that the pool should
 * treat as an endpoint failure — so it fails over, records a failure, and can
 * eject, instead of committing to a node that just told us it cannot serve.
 *
 * Returns undefined for a normal response, for caller faults, and for any code
 * outside the allowlist (including transaction-level errors like a failed
 * simulation, which another endpoint would report identically).
 */
export function nodeStateError(response: unknown): RpcNodeStateError | undefined {
  const err = jsonRpcErrorOf(response);
  if (err === undefined) return undefined;
  // Checked first: a caller fault stays a caller fault even if its message
  // happens to contain the words below.
  if (CLIENT_FAULT_CODES.has(err.code)) return undefined;

  const rateLimited = err.code === 429 || RATE_LIMIT_TEXT.test(err.message);
  if (!rateLimited && !NODE_STATE_CODES.has(err.code)) return undefined;

  // Reusing statusCode 429 lets isRateLimited() and the existing
  // rateLimitEjectionMs window apply with no further plumbing.
  return new RpcNodeStateError(err.code, err.message, rateLimited ? 429 : undefined);
}
