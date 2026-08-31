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
