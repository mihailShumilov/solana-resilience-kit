/**
 * ConfirmationTracker — polls a transaction to a terminal outcome using the
 * correct Solana semantics: confirmation is decided by comparing current block
 * height against the transaction's `lastValidBlockHeight`, NOT by a timeout.
 * Once block height passes the deadline and the signature still has no status,
 * the transaction is expired (terminal) and must never be retried as-is.
 *
 * Optionally, a WebSocket fast-path runs ALONGSIDE the poll loop: when an
 * `RpcSubscriptions`-shaped dependency is injected, a `signatureNotifications`
 * subscription races the poll loop and resolves on whichever fires first. The
 * subscription only ever produces a positive result (`confirmed`/`failed`); the
 * poll loop remains the sole authority for the EXPIRY bound (block height past
 * `lastValidBlockHeight`). WS is best-effort: any subscription error/close
 * silently falls back to pure polling, so there is never a regression.
 */
import type { Rpc, Signature, SolanaRpcApi } from "@solana/kit";
import type { HealthMonitor } from "../rpc/health.js";
import type { LifecycleEmitter } from "../events.js";

/** Three terminal outcomes: it confirmed, it landed-but-failed, or it expired. */
export type TerminalOutcome = "confirmed" | "failed" | "expired";

/**
 * Which side of the WS-vs-poll race delivered the outcome (issue #10). Pure
 * polling and expiry always report "poll"; only a subscription-delivered
 * result reports "ws". Attribution never alters the outcome itself.
 */
export type ConfirmationPath = "ws" | "poll";

/** A named, pre-built RPC client the tracker may poll for signature status. */
export interface ConfirmationEndpoint {
  name: string;
  rpc: Rpc<SolanaRpcApi>;
}

/**
 * Fan-out confirmation polling across the freshest healthy endpoints (issue #4),
 * to beat the "status withheld by a lagging node" failure class. Clients are
 * REUSED every round — the tracker never constructs an RPC client per poll.
 */
export interface MultiEndpointConfig {
  endpoints: ConfirmationEndpoint[];
  /** Ranks endpoints by freshness; the tracker polls the top-K healthy ones. */
  healthMonitor: HealthMonitor;
  /** Endpoints to query per round (default = all; clamped to >= 1). K=1 == single-node. */
  k?: number;
}

/**
 * Minimal structural slice of the kit/v2 `RpcSubscriptions` surface that the
 * fast-path uses. A real `RpcSubscriptions<SolanaRpcSubscriptionsApi>` from
 * `@solana/kit` satisfies this; the test harness provides a deterministic mock.
 */
export interface SignatureSubscriptionsApi {
  signatureNotifications(
    signature: Signature,
    config?: { commitment?: "confirmed" | "finalized" },
  ): {
    subscribe(options: { abortSignal: AbortSignal }): Promise<
      AsyncIterable<{ readonly context: { readonly slot: bigint }; readonly value: { readonly err: unknown } }>
    >;
  };
}

export interface TrackConfig {
  signature: string;
  lastValidBlockHeight: bigint;
  /** Target commitment for "confirmed" (default "confirmed"). */
  commitment?: "confirmed" | "finalized";
  /** Delay between polls in ms (default 500). */
  pollIntervalMs?: number;
}

export interface TrackResult {
  signature: string;
  outcome: TerminalOutcome;
  slot: bigint | null;
  polls: number;
  /** Which racer delivered the outcome: the WS fast-path or the poll loop. */
  via: ConfirmationPath;
  /** Present (and `!= null`) only when `outcome === "failed"`. */
  err?: unknown;
}

export interface ConfirmationDeps {
  /** Injected sleep so tests can advance the mock clock deterministically. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional kit/v2 subscriptions transport. When provided, a
   * `signatureNotifications` WebSocket fast-path races the poll loop. When
   * absent, behavior is identical to pure polling.
   */
  subscriptions?: SignatureSubscriptionsApi;
  /**
   * Optional multi-endpoint fan-out for status polling. When absent (or K=1),
   * polling uses the single primary `rpc` exactly as before.
   */
  multiEndpoint?: MultiEndpointConfig;
  /**
   * Optional lifecycle event stream (same pattern as `ResilientRpcPool`).
   * Used only to emit `transaction:ws-fallback` when the subscription errors
   * or closes without delivering (issue #10).
   */
  events?: LifecycleEmitter;
}

/** Normalized result of one status check (single- or multi-endpoint). */
interface StatusCheck {
  kind: "confirmed" | "failed" | "pending";
  slot: bigint | null;
  err?: unknown;
}

/** Commitment ordering: a higher rank satisfies a lower target. */
const COMMITMENT_RANK = { processed: 0, confirmed: 1, finalized: 2 } as const;

/** Internal sentinel: a racer that yielded no usable result (it abstains). */
const ABSTAIN = Symbol("abstain");
type Abstain = typeof ABSTAIN;

export class ConfirmationTracker {
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly subscriptions: SignatureSubscriptionsApi | undefined;
  private readonly multiEndpoint: MultiEndpointConfig | undefined;
  private readonly events: LifecycleEmitter | undefined;

  constructor(rpc: Rpc<SolanaRpcApi>, deps?: ConfirmationDeps) {
    this.rpc = rpc;
    this.sleep = deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.subscriptions = deps?.subscriptions;
    this.multiEndpoint = deps?.multiEndpoint;
    this.events = deps?.events;
  }

  /**
   * Resolves to a terminal outcome: confirmed, landed-but-failed, or expired.
   *
   * Termination is the canonical Solana rule: the loop is bounded solely by
   * `lastValidBlockHeight` (block height passing the deadline), never an
   * arbitrary poll cap that could mask the real bound. The WebSocket fast-path,
   * when configured, can only RESOLVE EARLIER (confirmed/failed) — it can never
   * extend the loop or override expiry.
   */
  async track(config: TrackConfig): Promise<TrackResult> {
    const ac = new AbortController();

    // No subscriptions injected: pure polling, identical to the original path.
    if (this.subscriptions === undefined) {
      const result = await this.pollLoop(config, ac.signal);
      // The poll loop only abstains when aborted, which never happens here.
      return result === ABSTAIN ? this.expired(config, 0) : result;
    }

    const pollPromise = this.pollLoop(config, ac.signal);
    const wsPromise = this.wsWait(config, ac);
    try {
      const winner = await Promise.race([pollPromise, wsPromise]);
      // The race can be won by the poll loop's ABSTAIN: when the WS path gets a
      // notification it calls ac.abort(), and the poll loop's resulting ABSTAIN
      // may settle before the WS path's own return. In that case the real
      // outcome lives on wsPromise. (Symmetrically, if wsPromise abstains it
      // only settles after ac aborts — i.e. after the poll loop already won —
      // so a real poll result wins the race directly.)
      if (winner !== ABSTAIN) return winner;
      const ws = await wsPromise;
      if (ws !== ABSTAIN) return ws;
      const polled = await pollPromise;
      return polled === ABSTAIN ? this.expired(config, 0) : polled;
    } finally {
      ac.abort();
      // Swallow the loser so a late WS error can never become an unhandled
      // rejection after the race has already settled.
      void pollPromise.catch(() => undefined);
      void wsPromise.catch(() => undefined);
    }
  }

  /**
   * The poll loop. Bounded strictly by `lastValidBlockHeight`. Honors `signal`:
   * if the WS fast-path wins, the loop stops WITHOUT issuing another status
   * poll, so no `getSignatureStatuses` call is ever made after the WS event.
   */
  private async pollLoop(config: TrackConfig, signal: AbortSignal): Promise<TrackResult | Abstain> {
    const target = config.commitment ?? "confirmed";
    const targetRank = COMMITMENT_RANK[target];
    const pollIntervalMs = config.pollIntervalMs ?? 500;
    const signature = config.signature as Signature;
    let polls = 0;

    for (;;) {
      if (signal.aborted) return ABSTAIN;

      // Check the signature status FIRST: a tx can land exactly at the deadline
      // block, so this must win over the expiry bound below. With a
      // multi-endpoint config this fans out across the freshest healthy nodes.
      const status = await this.checkStatus(signature, targetRank);
      // The WS path may have won while we awaited; don't count this poll.
      if (signal.aborted) return ABSTAIN;
      polls++;

      // Landed but failed on-chain: terminal, surfaced for the sender.
      if (status.kind === "failed") {
        return { signature: config.signature, outcome: "failed", slot: status.slot, polls, via: "poll", err: status.err };
      }
      if (status.kind === "confirmed") {
        return { signature: config.signature, outcome: "confirmed", slot: status.slot, polls, via: "poll" };
      }

      // Termination bound: once current block height passes the caller-supplied
      // lastValidBlockHeight, the blockhash is dead and the tx can never land.
      // Read height from the freshest client so a lagging node can't fake expiry.
      const blockHeight = await this.statusClients()[0]!.getBlockHeight().send();
      if (signal.aborted) return ABSTAIN;
      if (blockHeight > config.lastValidBlockHeight) {
        return { signature: config.signature, outcome: "expired", slot: null, polls, via: "poll" };
      }

      await this.sleep(pollIntervalMs);
    }
  }

  /**
   * The WebSocket fast-path. Resolves on the first `signatureNotifications`
   * event (confirmed, or failed when `err != null`). On ANY subscription error
   * or a stream that closes without delivering, it abstains and waits for the
   * poll loop to decide — guaranteeing no regression versus pure polling.
   */
  private async wsWait(config: TrackConfig, ac: AbortController): Promise<TrackResult | Abstain> {
    const target = config.commitment ?? "confirmed";
    const signature = config.signature as Signature;
    try {
      const pending = this.subscriptions!.signatureNotifications(signature, { commitment: target });
      const notifications = await pending.subscribe({ abortSignal: ac.signal });
      for await (const notification of notifications) {
        // Abort the poll loop immediately so it issues no further status polls.
        ac.abort();
        if (notification.value.err != null) {
          return {
            signature: config.signature,
            outcome: "failed",
            slot: notification.context.slot,
            polls: 0,
            via: "ws",
            err: notification.value.err,
          };
        }
        return { signature: config.signature, outcome: "confirmed", slot: notification.context.slot, polls: 0, via: "ws" };
      }
      // Closed without delivering: a genuine disconnect (issue #10) — unless
      // the poll loop already won and the abort is what ended the stream.
      this.emitWsFallback(config.signature, "subscription closed without delivering", ac.signal);
    } catch (err) {
      // best-effort: any subscription failure falls back to polling.
      this.emitWsFallback(config.signature, err instanceof Error ? err.message : String(err), ac.signal);
    }
    // Subscribe failed or the stream closed empty: abstain until the poll loop
    // wins (which aborts `ac`), so this never settles the race prematurely.
    await waitForAbort(ac.signal);
    return ABSTAIN;
  }

  /**
   * Emit `transaction:ws-fallback` for a genuine subscription failure. Once
   * `ac` is aborted the race is already decided, so an abort-induced stream
   * close/error is NOT a fallback and stays silent (issue #10).
   */
  private emitWsFallback(signature: string, reason: string, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.events?.emit("transaction:ws-fallback", { signature, reason });
  }

  /**
   * The RPC clients to poll for status this round: the top-K freshest healthy
   * endpoints when multi-endpoint is configured, otherwise just the primary
   * `rpc`. The SAME client instances are reused every round — never re-created.
   */
  private statusClients(): Rpc<SolanaRpcApi>[] {
    const me = this.multiEndpoint;
    if (me === undefined) return [this.rpc];

    const k = Math.max(1, me.k ?? me.endpoints.length);
    const byName = new Map(me.endpoints.map((e) => [e.name, e.rpc]));
    const ranked = me.healthMonitor
      .rankByFreshness()
      .map((name) => byName.get(name))
      .filter((rpc): rpc is Rpc<SolanaRpcApi> => rpc !== undefined);
    // No health data yet → fall back to the configured order so we still fan out.
    const ordered = ranked.length > 0 ? ranked : me.endpoints.map((e) => e.rpc);
    return ordered.slice(0, k);
  }

  /**
   * One status check. Single client → one query. Multiple → `Promise.allSettled`
   * fan-out: a definitive on-chain `err` from ANY node fails fast; otherwise a
   * `confirmed` from ANY node wins; endpoint errors/timeouts are tolerated as
   * long as one client answers.
   */
  private async checkStatus(signature: Signature, targetRank: number): Promise<StatusCheck> {
    const clients = this.statusClients();
    if (clients.length === 1) {
      const status = (await clients[0]!.getSignatureStatuses([signature]).send()).value[0];
      return classifyStatus(status, targetRank);
    }

    const settled = await Promise.allSettled(
      clients.map((rpc) => rpc.getSignatureStatuses([signature]).send()),
    );
    let confirmed: StatusCheck | undefined;
    for (const result of settled) {
      if (result.status !== "fulfilled") continue; // tolerate a dead endpoint
      const check = classifyStatus(result.value.value[0], targetRank);
      if (check.kind === "failed") return check; // definitive on-chain error wins
      if (check.kind === "confirmed") confirmed = check;
    }
    return confirmed ?? { kind: "pending", slot: null };
  }

  private expired(config: TrackConfig, polls: number): TrackResult {
    return { signature: config.signature, outcome: "expired", slot: null, polls, via: "poll" };
  }
}

/** Map a raw signature status to a normalized {@link StatusCheck}. */
function classifyStatus(
  status:
    | null
    | { slot: bigint; err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" | null }
    | undefined,
  targetRank: number,
): StatusCheck {
  if (status == null) return { kind: "pending", slot: null };
  if (status.err != null) return { kind: "failed", slot: status.slot, err: status.err };
  if (status.confirmationStatus != null && COMMITMENT_RANK[status.confirmationStatus] >= targetRank) {
    return { kind: "confirmed", slot: status.slot };
  }
  return { kind: "pending", slot: null };
}

/** Resolves once the signal aborts (or immediately if already aborted). */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
