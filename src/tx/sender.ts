/**
 * TransactionSender — the resilient send/confirm state machine. Implements the
 * landing best-practices the docs prescribe and most submissions get wrong:
 *   - send with maxRetries: 0 (disable the RPC's generic retry),
 *   - run our own rebroadcast loop at a fixed interval,
 *   - bound the loop by lastValidBlockHeight (stop, don't spin forever),
 *   - NEVER re-sign / mutate the transaction (no double-charge risk),
 *   - decide the outcome via ConfirmationTracker.
 *
 * Input is an already-signed wire transaction plus its signature and
 * lastValidBlockHeight, so signing (and wallet integration) stays decoupled.
 */
import type { Base64EncodedWireTransaction, Rpc, SolanaRpcApi } from "@solana/kit";
import type { Metrics } from "../observability/metrics.js";
import { ConfirmationTracker, type SignatureSubscriptionsApi, type TerminalOutcome } from "./confirmation.js";
import { ErrorTranslator } from "../error-translator.js";
import type { LifecycleEmitter } from "../events.js";
import { ClusterDetector, type ClusterGuardConfig } from "../rpc/cluster.js";
import { ClusterMismatchError } from "../errors.js";

export interface SendConfig {
  /** Base64 wire transaction (from getBase64EncodedWireTransaction). */
  wireTransaction: string;
  /** Its signature (from getSignatureFromTransaction). */
  signature: string;
  lastValidBlockHeight: bigint;
  /** Interval between rebroadcasts in ms (default 1000). */
  rebroadcastIntervalMs?: number;
  /** Commitment for confirmation (default "confirmed"). */
  commitment?: "confirmed" | "finalized";
  /** Stable logical id for lifecycle events; defaults to the signature. */
  txId?: string;
}

export interface SendResult {
  signature: string;
  outcome: TerminalOutcome;
  slot: bigint | null;
  rebroadcasts: number;
}

export interface SenderDeps {
  /** Injected sleep so tests advance the mock clock per loop iteration. */
  sleep?: (ms: number) => Promise<void>;
  metrics?: Metrics;
  /** Optional typed lifecycle event stream for dApp UIs. */
  events?: LifecycleEmitter;
  /** Optional guard that blocks/warns when the RPC is on the wrong cluster. */
  clusterGuard?: ClusterGuardConfig;
  /**
   * Optional kit/v2 subscriptions transport, passed through to the internal
   * ConfirmationTracker so its WS fast-path races the poll loop (issue #10).
   */
  subscriptions?: SignatureSubscriptionsApi;
}

export class TransactionSender {
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly metrics: Metrics | undefined;
  private readonly events: LifecycleEmitter | undefined;
  private readonly clusterGuard: ClusterGuardConfig | undefined;
  private readonly clusterDetector: ClusterDetector;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly subscriptions: SignatureSubscriptionsApi | undefined;

  constructor(rpc: Rpc<SolanaRpcApi>, deps?: SenderDeps) {
    this.rpc = rpc;
    this.metrics = deps?.metrics;
    this.events = deps?.events;
    this.clusterGuard = deps?.clusterGuard;
    this.clusterDetector = deps?.clusterGuard?.detector ?? new ClusterDetector();
    this.sleep = deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.subscriptions = deps?.subscriptions;
  }

  /**
   * Cluster guard: detect the RPC's cluster (cached) and, on a definitive
   * mismatch with the expected cluster, either throw a {@link ClusterMismatchError}
   * BEFORE any broadcast (`throw`) or emit `connection:cluster-mismatch` and
   * proceed (`warn`). An `unknown` cluster (detection failed) never blocks — we
   * don't turn a transient genesis-lookup failure into a hard error.
   */
  private async guardCluster(): Promise<void> {
    const guard = this.clusterGuard;
    if (guard === undefined || guard.mode === "off") return;

    const info = await this.clusterDetector.detectFromRpc(this.rpc);
    if (info.cluster !== "unknown") {
      this.events?.emit("connection:cluster-detected", {
        cluster: info.cluster,
        genesisHash: info.genesisHash ?? "",
      });
    }
    if (info.cluster === "unknown" || info.cluster === guard.expected) return;

    this.events?.emit("connection:cluster-mismatch", {
      expected: guard.expected,
      actual: info.cluster,
      genesisHash: info.genesisHash ?? "",
    });
    if ((guard.mode ?? "throw") === "throw") {
      throw new ClusterMismatchError(guard.expected, info.cluster, info.genesisHash);
    }
  }

  /**
   * Sends and rebroadcasts until confirmed or blockhash expiry.
   *
   * Correctness invariants (see CLAUDE.md):
   *  - Every send uses `maxRetries: 0n` so the RPC's generic retry is disabled
   *    and we own the rebroadcast loop. (kit downcasts the bigint to `0` in the
   *    JSON-RPC payload.)
   *  - Rebroadcast = resend the SAME signed bytes. We never decode, mutate, or
   *    re-sign the transaction, and we return `config.signature` verbatim — so
   *    there is no double-charge risk.
   *  - Termination is delegated to ConfirmationTracker's `lastValidBlockHeight`
   *    bound; we add no arbitrary cap.
   */
  async sendAndConfirm(config: SendConfig): Promise<SendResult> {
    const broadcast = (): Promise<string> =>
      this.rpc
        .sendTransaction(config.wireTransaction as Base64EncodedWireTransaction, {
          maxRetries: 0n,
          encoding: "base64",
          preflightCommitment: config.commitment ?? "confirmed",
        })
        .send();

    // Guard the cluster BEFORE anything is broadcast: a wrong-network send must
    // never leave the client.
    await this.guardCluster();

    const txId = config.txId ?? config.signature;
    const startedAt = Date.now();
    let rebroadcasts = 0;
    const baseEvent = (): {
      txId: string;
      signature: string;
      attempt: number;
      durationMs: number;
    } => ({
      txId,
      signature: config.signature,
      attempt: rebroadcasts,
      durationMs: Date.now() - startedAt,
    });

    this.events?.emit("transaction:pending", baseEvent());

    // Initial broadcast: the first send, with maxRetries disabled. A failure
    // here is a genuine signal that the transaction is malformed or unfundable
    // (e.g. InsufficientFundsForRent / bad blockhash) and will never land, so we
    // surface it immediately rather than spinning the confirm loop. The raw RPC
    // error is translated into an actionable SdkError at this boundary.
    try {
      await broadcast();
    } catch (err) {
      const translated = ErrorTranslator.translate(err, { extra: "sendTransaction" });
      this.events?.emit("transaction:failed", { ...baseEvent(), err: translated });
      throw translated;
    }
    this.events?.emit("transaction:sent", baseEvent());

    // A fresh tracker per call. Its sleep hook is where we rebroadcast: the
    // tracker checks status BEFORE sleeping, so an unlanded tx triggers at least
    // one resend of the identical signed bytes before the next status check.
    const tracker = new ConfirmationTracker(this.rpc, {
      subscriptions: this.subscriptions,
      events: this.events,
      sleep: async (ms) => {
        // Resend the SAME signed bytes (never re-sign). Once the tx lands, an
        // RPC rejects a resend with "already processed" (a preflight failure),
        // and transient transport errors are possible too. NONE of these are
        // terminal: the outcome is decided solely by confirmation status bounded
        // by lastValidBlockHeight. Swallow the error so a failed resend can never
        // turn an already-landed transaction into a reported failure.
        try {
          await broadcast();
        } catch {
          // expected on resend (already-processed / transient) — keep polling
        }
        rebroadcasts++;
        this.metrics?.recordRebroadcast(config.signature);
        await this.sleep(ms); // injected sleep advances the (mock) clock
      },
    });

    const res = await tracker.track({
      signature: config.signature,
      lastValidBlockHeight: config.lastValidBlockHeight,
      commitment: config.commitment,
      pollIntervalMs: config.rebroadcastIntervalMs,
    });

    this.metrics?.recordLanding(config.signature, res.outcome, res.polls, res.via);

    if (res.outcome === "confirmed") {
      this.events?.emit("transaction:confirmed", { ...baseEvent(), slot: res.slot, via: res.via });
    } else if (res.outcome === "failed") {
      this.events?.emit("transaction:failed", { ...baseEvent(), err: res.err, via: res.via });
    } else {
      this.events?.emit("transaction:expired", baseEvent());
    }

    return {
      signature: config.signature,
      outcome: res.outcome,
      slot: res.slot,
      rebroadcasts,
    };
  }
}
