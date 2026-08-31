/**
 * HealthMonitor — tracks per-endpoint freshness and reliability so the pool can
 * route to healthy, up-to-date nodes and avoid the "lagging node drops your tx"
 * failure mode. Freshness is judged by comparing observed slots across
 * endpoints; an endpoint more than `maxSlotLag` behind the best is unhealthy.
 *
 * It also owns the CIRCUIT BREAKER (issue #17). Knowing an endpoint is
 * unhealthy is not enough: a quota-constrained deployment needs the pool to
 * stop *calling* it. An endpoint that trips `failureThreshold` consecutive
 * failures is EJECTED for a cooldown — skipped with no network call at all —
 * then admitted once, half-open, to see whether it recovered. A 429 earns the
 * longer `rateLimitEjectionMs` cooldown, because that is the provider telling
 * you the budget is gone; an explicit `Retry-After` beats both guesses.
 */
import { isRateLimited, retryAfterMs } from "./http-status.js";

export interface EndpointHealth {
  name: string;
  healthy: boolean;
  slot: bigint | null;
  /** Exponentially-weighted mean latency in ms. */
  latencyMs: number;
  /** Rolling error rate in [0,1]. */
  errorRate: number;
  consecutiveFailures: number;
  lastError: unknown | null;
  /** True while the circuit is open — the pool will not contact this endpoint. */
  ejected: boolean;
  /** Timestamp (ms, from the injected clock) the ejection window expires. */
  ejectedUntil: number | null;
}

export interface HealthMonitorConfig {
  endpointNames: string[];
  /** Slots behind the freshest node before an endpoint is deemed stale. */
  maxSlotLag?: bigint;
  /** Consecutive failures before an endpoint is ejected. */
  failureThreshold?: number;
  /** EWMA smoothing factor for latency (0..1). */
  latencyAlpha?: number;
  /** Cooldown for an ordinary failure (default 30s). `0` disables ejection. */
  ejectionMs?: number;
  /** Cooldown for a 429 — a spent quota needs longer than a blip (default 5min). */
  rateLimitEjectionMs?: number;
  /** Injected clock, so cooldowns are testable without wall-clock waits. */
  now?: () => number;
}

/** Internal mutable state. `latencySeeded` distinguishes "no sample yet" from a
 * genuine 0ms sample so the EWMA can take the first sample verbatim. */
interface EndpointState {
  name: string;
  slot: bigint | null;
  latencyMs: number;
  latencySeeded: boolean;
  errorRate: number;
  consecutiveFailures: number;
  lastError: unknown | null;
  /** null = circuit closed. Otherwise the ms timestamp the window expires. */
  ejectedUntil: number | null;
  /** The cooldown that produced the current window, reused when half-open. */
  ejectionMs: number;
}

/** Step applied to errorRate per success (down) / failure (up). Keeps the rate
 * a bounded [0,1] rolling signal without needing a full window of samples. */
const ERROR_RATE_STEP = 0.1;

const DEFAULT_EJECTION_MS = 30_000;
const DEFAULT_RATE_LIMIT_EJECTION_MS = 300_000;

export class HealthMonitor {
  private readonly maxSlotLag: bigint;
  private readonly failureThreshold: number;
  private readonly latencyAlpha: number;
  private readonly ejectionMs: number;
  private readonly rateLimitEjectionMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, EndpointState>();

  constructor(config: HealthMonitorConfig) {
    this.maxSlotLag = config.maxSlotLag ?? 150n;
    this.failureThreshold = config.failureThreshold ?? 3;
    this.latencyAlpha = config.latencyAlpha ?? 0.3;
    this.ejectionMs = config.ejectionMs ?? DEFAULT_EJECTION_MS;
    this.rateLimitEjectionMs = config.rateLimitEjectionMs ?? DEFAULT_RATE_LIMIT_EJECTION_MS;
    this.now = config.now ?? Date.now;

    for (const name of config.endpointNames) {
      this.states.set(name, {
        name,
        slot: null,
        latencyMs: 0,
        latencySeeded: false,
        errorRate: 0,
        consecutiveFailures: 0,
        lastError: null,
        ejectedUntil: null,
        ejectionMs: 0,
      });
    }
  }

  recordSuccess(endpoint: string, latencyMs: number, slot?: bigint): void {
    const state = this.states.get(endpoint);
    if (state === undefined) return; // guard unknown endpoint names

    state.consecutiveFailures = 0;
    // A success closes the circuit: the half-open attempt paid off.
    state.ejectedUntil = null;
    state.ejectionMs = 0;

    if (!state.latencySeeded) {
      state.latencyMs = latencyMs;
      state.latencySeeded = true;
    } else {
      state.latencyMs =
        this.latencyAlpha * latencyMs + (1 - this.latencyAlpha) * state.latencyMs;
    }

    if (slot !== undefined) {
      state.slot = slot;
    }

    state.errorRate = clamp01(state.errorRate - ERROR_RATE_STEP);
    state.lastError = null;
  }

  recordFailure(endpoint: string, error: unknown): void {
    const state = this.states.get(endpoint);
    if (state === undefined) return; // guard unknown endpoint names

    state.consecutiveFailures += 1;
    state.lastError = error;
    state.errorRate = clamp01(state.errorRate + ERROR_RATE_STEP);

    if (state.consecutiveFailures >= this.failureThreshold) {
      const cooldown = this.cooldownFor(error);
      if (cooldown > 0) {
        state.ejectionMs = cooldown;
        state.ejectedUntil = this.now() + cooldown;
      }
    }
  }

  isHealthy(endpoint: string): boolean {
    const state = this.states.get(endpoint);
    if (state === undefined) return false; // unknown endpoint is never healthy

    if (state.consecutiveFailures >= this.failureThreshold) return false;

    if (state.slot !== null) {
      const lag = this.freshestSlot() - state.slot;
      if (lag > this.maxSlotLag) return false;
    }

    return true;
  }

  /** When the current ejection window expires; null when never ejected. */
  ejectedUntil(endpoint: string): number | null {
    return this.states.get(endpoint)?.ejectedUntil ?? null;
  }

  /** True while the circuit is open. Pure — see {@link tryAdmit} to act on it. */
  isEjected(endpoint: string): boolean {
    const state = this.states.get(endpoint);
    if (state === undefined || state.ejectedUntil === null) return false;
    return this.now() < state.ejectedUntil;
  }

  /**
   * May the caller contact this endpoint right now? `false` means the circuit
   * is open and the caller must skip it WITHOUT a network call.
   *
   * When the window has just expired this spends the single half-open attempt:
   * the window is re-armed so a concurrent caller still waits, and the outcome
   * of the attempt then closes the circuit ({@link recordSuccess}) or re-opens
   * it with a fresh cooldown ({@link recordFailure}).
   */
  tryAdmit(endpoint: string): boolean {
    const state = this.states.get(endpoint);
    if (state === undefined) return false; // never dial an endpoint we don't know
    if (state.ejectedUntil === null) return true;

    if (this.now() < state.ejectedUntil) return false;

    state.ejectedUntil = this.now() + state.ejectionMs;
    return true;
  }

  /** Healthy endpoints ordered best-first (freshest slot, then lowest latency). */
  rankByFreshness(): string[] {
    return [...this.states.values()]
      .filter((s) => this.isHealthy(s.name))
      .sort((a, b) => {
        // Freshest slot first; nulls sort last.
        if (a.slot !== b.slot) {
          if (a.slot === null) return 1;
          if (b.slot === null) return -1;
          if (a.slot > b.slot) return -1;
          if (a.slot < b.slot) return 1;
        }
        // Tie-break: lower latency first.
        return a.latencyMs - b.latencyMs;
      })
      .map((s) => s.name);
  }

  snapshot(): EndpointHealth[] {
    return [...this.states.values()].map((s) => ({
      name: s.name,
      healthy: this.isHealthy(s.name),
      slot: s.slot,
      latencyMs: s.latencyMs,
      errorRate: s.errorRate,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
      ejected: this.isEjected(s.name),
      ejectedUntil: s.ejectedUntil,
    }));
  }

  /** How long to keep an endpoint out of rotation after `error`. */
  private cooldownFor(error: unknown): number {
    if (this.ejectionMs <= 0) return 0; // breaker disabled
    if (!isRateLimited(error)) return this.ejectionMs;
    // The provider's own hint beats our guess, but never shortens the base
    // cooldown — a 1-second Retry-After is not a reason to hammer it again.
    const hint = retryAfterMs(error);
    if (hint !== undefined) return Math.max(hint, this.ejectionMs);
    return Math.max(this.rateLimitEjectionMs, this.ejectionMs);
  }

  /** Max of all non-null observed slots across endpoints; 0n when none seen. */
  private freshestSlot(): bigint {
    let max = 0n;
    for (const state of this.states.values()) {
      if (state.slot !== null && state.slot > max) {
        max = state.slot;
      }
    }
    return max;
  }
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
