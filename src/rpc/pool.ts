/**
 * ResilientRpcPool — the heart of the RPC layer. Wraps N endpoints behind a
 * single `@solana/kit`-compatible RpcTransport that:
 *   - routes to the freshest healthy endpoint (via HealthMonitor),
 *   - fails over to the next endpoint on 429 / transport error,
 *   - ejects an endpoint that keeps failing, so it costs zero traffic,
 *   - meters weighted credits to pre-empt 429s (CreditRateLimiter),
 *   - emits per-request metrics.
 *
 * Because it exposes a real RpcTransport, callers build a normal kit RPC with
 * `pool.rpc()` and use it exactly like any kit RPC — that is the web3.js-v2
 * compatibility guarantee plus DX win.
 */
// Import from the peer `@solana/kit` (which re-exports @solana/rpc-spec) so the
// emitted d.ts never references a package consumers can't resolve under pnpm's
// strict node-linker (issue #8).
import { createSolanaRpcFromTransport, type Rpc, type RpcTransport, type SolanaRpcApi } from "@solana/kit";
import { AllEndpointsFailedError, EndpointEjectedError } from "../errors.js";
import { HealthMonitor, type EndpointHealth } from "./health.js";
import { isRateLimited, nodeStateError } from "./http-status.js";
import type { CreditRateLimiter } from "./rate-limit.js";
import type { Metrics } from "../observability/metrics.js";
import type { LifecycleEmitter } from "../events.js";

/** Minimal shape of the JSON-RPC payload a kit transport receives. */
interface JsonRpcPayload {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown[];
}

/** Minimal shape of a JSON-RPC response a transport returns. A node reporting
 * its own state answers HTTP 200 with `error` instead of `result` (issue #19). */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
  error?: { code: number; message?: string };
}

/** Default gap between freshness probe rounds. */
const DEFAULT_HEALTH_REFRESH_MS = 2_000;

/** Best-effort human reason string for a failover event. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Defensively read a bigint slot off a getSlot response (result is the slot). */
function slotFromResponse(response: JsonRpcResponse): bigint | undefined {
  return typeof response.result === "bigint" ? response.result : undefined;
}

export interface ResilientEndpoint {
  name: string;
  /** A kit-compatible transport (HTTP transport in prod, MockEndpoint in tests). */
  transport: RpcTransport;
  /** Relative routing weight among equally-fresh endpoints (default 1). */
  weight?: number;
}

export interface ResilientRpcConfig {
  endpoints: ResilientEndpoint[];
  /** Max endpoint attempts per logical request (default = endpoints.length). */
  maxAttempts?: number;
  /** Route to the freshest healthy node first (default true). */
  freshnessAware?: boolean;
  /** Send the same read to N endpoints and take the first response (default 1). */
  hedge?: number;
  /**
   * Minimum gap between freshness probe rounds (default 2000ms). Between
   * rounds the last observed slot is reused, so probing costs one extra
   * `getSlot` per endpoint per interval instead of one per logical request.
   */
  healthRefreshMs?: number;
  healthMonitor?: HealthMonitor;
  rateLimiter?: CreditRateLimiter;
  metrics?: Metrics;
  /** Optional typed lifecycle event stream (failover / health for dApp UIs). */
  events?: LifecycleEmitter;
  /** Injected clock for the probe cadence (defaults to `Date.now`). */
  now?: () => number;
}

export class ResilientRpcPool {
  private readonly endpoints: ResilientEndpoint[];
  private readonly endpointNames: string[];
  private readonly byName: Map<string, ResilientEndpoint>;
  private readonly healthMonitor: HealthMonitor;
  private readonly rateLimiter?: CreditRateLimiter;
  private readonly metrics?: Metrics;
  private readonly events?: LifecycleEmitter;
  private readonly freshnessAware: boolean;
  private readonly maxAttempts: number;
  private readonly healthRefreshMs: number;
  private readonly now: () => number;
  /** Timestamp of the last freshness probe round; null = never probed. */
  private lastProbeAt: number | null = null;
  /** Last-known health per endpoint, so we only emit `connection:health` on change. */
  private readonly lastHealthy = new Map<string, boolean>();

  constructor(config: ResilientRpcConfig) {
    this.endpoints = config.endpoints;
    this.endpointNames = config.endpoints.map((e) => e.name);
    this.byName = new Map(config.endpoints.map((e) => [e.name, e]));
    this.now = config.now ?? Date.now;
    this.healthMonitor =
      config.healthMonitor ??
      new HealthMonitor({ endpointNames: this.endpointNames, maxSlotLag: 150n, now: this.now });
    this.rateLimiter = config.rateLimiter;
    this.metrics = config.metrics;
    this.events = config.events;
    this.freshnessAware = config.freshnessAware ?? true;
    this.maxAttempts = config.maxAttempts ?? config.endpoints.length;
    this.healthRefreshMs = config.healthRefreshMs ?? DEFAULT_HEALTH_REFRESH_MS;
    // Assume healthy at start so the first successful request is not noise; only
    // a genuine transition (ejection / recovery) emits a `connection:health`.
    for (const name of this.endpointNames) this.lastHealthy.set(name, true);
  }

  /** The failover transport. Plug into `createSolanaRpcFromTransport`. */
  get transport(): RpcTransport {
    const transport = async <TResponse>(config: {
      payload: unknown;
      signal?: AbortSignal;
    }): Promise<TResponse> => {
      const payload = config.payload as JsonRpcPayload;
      const method = payload.method;

      await this.refreshHealth();
      const order = this.attemptOrder();

      const attempts: Array<{ endpoint: string; error: unknown }> = [];
      let used = 0;

      for (const name of order) {
        if (used >= this.maxAttempts) break;
        const endpoint = this.byName.get(name);
        if (endpoint === undefined) continue;

        // Circuit breaker (issue #17): an ejected endpoint is skipped with NO
        // network call — the whole point is that a provider which is already
        // rejecting us stops costing latency and quota. It is deliberately NOT
        // recorded in the Metrics sink: we never contacted it, so counting it
        // as a failed request would drag the reported success rate down for an
        // endpoint that was never asked anything.
        if (!this.healthMonitor.tryAdmit(name)) {
          const until = this.healthMonitor.ejectedUntil(name);
          attempts.push({ endpoint: name, error: new EndpointEjectedError(name, until) });
          continue;
        }

        used += 1;

        // Optional credit gating: a dry bucket is a soft failure — advance on.
        if (this.rateLimiter !== undefined && !this.rateLimiter.tryAcquire(method)) {
          attempts.push({ endpoint: name, error: new Error("rate limiter: no credits") });
          continue;
        }

        // Date.now() here is a metric value, not loop control — acceptable.
        const start = Date.now();
        try {
          const response = (await endpoint.transport(config)) as JsonRpcResponse;
          // A node that is behind, or missing a block, answers HTTP 200 with a
          // JSON-RPC error body — kit resolves that, it never throws. Turning it
          // into a throw here puts it through the SAME failover / health /
          // ejection path as any other endpoint failure (issue #19). Caller
          // faults are left alone: every endpoint would repeat them.
          const bodyError = nodeStateError(response);
          if (bodyError !== undefined) throw bodyError;
          const latencyMs = Date.now() - start;
          const slot = method === "getSlot" ? slotFromResponse(response) : undefined;
          this.healthMonitor.recordSuccess(name, latencyMs, slot);
          if (slot !== undefined) this.metrics?.recordSlot(name, slot);
          this.metrics?.recordRequest(name, method, latencyMs, true);
          // We reached this endpoint only after one or more prior endpoints
          // failed this request → that is a failover.
          if (attempts.length > 0) {
            const prev = attempts[attempts.length - 1] as { endpoint: string; error: unknown };
            this.events?.emit("connection:failover", {
              from: prev.endpoint,
              to: name,
              reason: errorMessage(prev.error),
            });
          }
          this.noteHealth(name);
          return response as unknown as TResponse;
        } catch (err) {
          const latencyMs = Date.now() - start;
          if (isRateLimited(err)) this.metrics?.recordRateLimited(name);
          this.healthMonitor.recordFailure(name, err);
          this.metrics?.recordRequest(name, method, latencyMs, false);
          this.noteHealth(name);
          attempts.push({ endpoint: name, error: err });
        }
      }

      throw new AllEndpointsFailedError(attempts);
    };

    return transport as RpcTransport;
  }

  /** A ready-to-use kit RPC backed by the resilient transport. */
  rpc(): Rpc<SolanaRpcApi> {
    return createSolanaRpcFromTransport(this.transport);
  }

  /** Current per-endpoint health snapshot (for monitoring / CLI). */
  health(): EndpointHealth[] {
    return this.healthMonitor.snapshot();
  }

  /**
   * Probe round, run before each logical request but rate-limited by time.
   *
   * Two independent reasons to spend a `getSlot`:
   *  - FRESHNESS: keep the slot ranking current. Gated by `healthRefreshMs`,
   *    so a pool of 3 endpoints costs 3 probes per interval rather than 3 per
   *    logical request (which was 4 requests of traffic per 1 of work).
   *  - RECOVERY: an ejected endpoint whose cooldown just expired gets its one
   *    half-open attempt here, because a probe is the cheapest possible way to
   *    ask "are you back?" — and in config order (`freshnessAware: false`) a
   *    degraded endpoint is ranked last, so it would otherwise never be
   *    reached by a real request and could never recover.
   *
   * Probe errors never escape.
   */
  private async refreshHealth(): Promise<void> {
    const now = this.now();
    const freshnessDue =
      this.freshnessAware && (this.lastProbeAt === null || now - this.lastProbeAt >= this.healthRefreshMs);

    const due: ResilientEndpoint[] = [];
    for (const endpoint of this.endpoints) {
      // The breaker gates dialling: false while the window is open, and it
      // spends the single half-open attempt when the window has just expired.
      if (!this.healthMonitor.tryAdmit(endpoint.name)) continue;
      // A window that is still set means we just spent that half-open attempt,
      // so this endpoint is mid-recovery and the probe is what checks on it.
      const recovering = this.healthMonitor.ejectedUntil(endpoint.name) !== null;
      if (freshnessDue || recovering) due.push(endpoint);
    }

    if (freshnessDue) this.lastProbeAt = now;
    if (due.length === 0) return;
    await Promise.all(due.map((e) => this.probe(e)));
  }

  /**
   * Builds the per-request attempt order. Health is respected in BOTH modes
   * (issue #17): an endpoint that has been failing is ranked behind the ones
   * that have not, instead of being attempted first forever because it happens
   * to be listed first. Config order is preserved within each group, and
   * degraded endpoints stay in the list as a last resort rather than being
   * dropped, so a fully-degraded pool still tries something.
   */
  private attemptOrder(): string[] {
    if (!this.freshnessAware) {
      const healthy: string[] = [];
      const degraded: string[] = [];
      for (const name of this.endpointNames) {
        (this.healthMonitor.isHealthy(name) ? healthy : degraded).push(name);
      }
      return [...healthy, ...degraded];
    }

    const ranked = this.healthMonitor.rankByFreshness();
    if (ranked.length === 0) return this.endpointNames;

    const seen = new Set(ranked);
    const fallback = this.endpointNames.filter((n) => !seen.has(n));
    return [...ranked, ...fallback];
  }

  /** Emit `connection:health` only when an endpoint's health actually flips. */
  private noteHealth(name: string): void {
    if (this.events === undefined) return;
    const healthy = this.healthMonitor.isHealthy(name);
    if (this.lastHealthy.get(name) === healthy) return;
    this.lastHealthy.set(name, healthy);
    const snap = this.healthMonitor.snapshot().find((s) => s.name === name);
    this.events.emit("connection:health", { endpoint: name, healthy, slot: snap?.slot ?? null });
  }

  /** Probe a single endpoint's getSlot, feeding health/metrics. Never throws. */
  private async probe(endpoint: ResilientEndpoint): Promise<void> {
    const probePayload: JsonRpcPayload = { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] };
    const start = Date.now();
    try {
      const response = (await endpoint.transport({ payload: probePayload })) as JsonRpcResponse;
      const bodyError = nodeStateError(response); // issue #19, on the probe path too
      if (bodyError !== undefined) throw bodyError;
      const latencyMs = Date.now() - start;
      const slot = slotFromResponse(response);
      this.healthMonitor.recordSuccess(endpoint.name, latencyMs, slot);
      if (slot !== undefined) this.metrics?.recordSlot(endpoint.name, slot);
      this.noteHealth(endpoint.name);
    } catch (err) {
      // Swallow: a probe failure must never abort the real request path. But
      // it MUST feed the metrics sink: a degraded endpoint is ranked out and
      // stops serving real traffic, so its probe failures are the only signal
      // an OTel dashboard ever sees (issue #9). Successful probes stay out of
      // recordRequest so synthetic traffic never inflates success counts.
      const latencyMs = Date.now() - start;
      if (isRateLimited(err)) this.metrics?.recordRateLimited(endpoint.name);
      this.healthMonitor.recordFailure(endpoint.name, err);
      this.metrics?.recordRequest(endpoint.name, probePayload.method, latencyMs, false);
      this.noteHealth(endpoint.name);
    }
  }
}
