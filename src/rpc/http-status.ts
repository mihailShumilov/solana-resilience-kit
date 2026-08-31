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
 * Pure and total: never throws, never does I/O.
 */

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
