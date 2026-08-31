/** Error taxonomy for the resilience kit. Distinct types so callers can branch. */

export class SdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown by every stub until the implementation phase fills it in. */
export class NotImplementedError extends SdkError {
  constructor(what = "not implemented") {
    super(what);
  }
}

/** A transaction's blockhash expired before it landed (terminal, not retryable). */
export class TransactionExpiredError extends SdkError {
  constructor(
    readonly signature: string,
    readonly lastValidBlockHeight: bigint,
  ) {
    super(`transaction ${signature} expired at block height ${lastValidBlockHeight}`);
  }
}

/** Every endpoint in the pool failed for a single logical request. */
export class AllEndpointsFailedError extends SdkError {
  constructor(readonly attempts: ReadonlyArray<{ endpoint: string; error: unknown }>) {
    super(`all ${attempts.length} endpoint attempt(s) failed`);
  }
}

/**
 * The pool skipped an endpoint because its circuit is open: it had already
 * tripped `failureThreshold`, so contacting it again before the cooldown
 * expires would only cost latency and quota (issue #17). No network call was
 * made, and no request was recorded against the endpoint.
 */
export class EndpointEjectedError extends SdkError {
  constructor(
    readonly endpoint: string,
    readonly ejectedUntil: number | null,
  ) {
    super(`endpoint ${endpoint} is ejected from rotation`);
  }
}

/**
 * A node answered HTTP 200 with a JSON-RPC `error` body describing its OWN
 * state — "behind by N slots", "block not available", "transaction history is
 * not available from this node" (issue #19). The request was fine; this
 * endpoint just cannot serve it, which is precisely the failure class another
 * endpoint is most likely to answer.
 *
 * `statusCode` is set to 429 when the body reports a rate limit, so the same
 * detection and cooldown that handle an HTTP 429 apply unchanged.
 */
export class RpcNodeStateError extends SdkError {
  constructor(
    readonly code: number,
    readonly rpcMessage: string,
    readonly statusCode?: number,
  ) {
    super(`RPC node reported error ${code}${rpcMessage === "" ? "" : `: ${rpcMessage}`}`);
  }
}

/** A Jito bundle did not land before its deadline; caller should fall back. */
export class BundleNotLandedError extends SdkError {
  constructor(readonly bundleId: string) {
    super(`bundle ${bundleId} did not land`);
  }
}

/** The RPC's cluster does not match the cluster the caller expected (wrong network). */
export class ClusterMismatchError extends SdkError {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly genesisHash: string | null,
  ) {
    super(
      `cluster mismatch: expected ${expected} but the RPC reports ${actual}` +
        (genesisHash !== null ? ` (genesis ${genesisHash})` : ""),
    );
  }
}
