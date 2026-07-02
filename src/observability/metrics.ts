/**
 * Observability surface. The SDK emits a small, fixed set of client-side
 * signals — the metrics the ecosystem currently re-implements by hand. The
 * `Metrics` interface decouples the SDK from any backend; `InMemoryMetrics` is
 * a real implementation used by tests to assert the SDK emits the right
 * signals, and `OtelMetrics` (to be implemented) bridges to OpenTelemetry /
 * Datadog via the OTLP exporter.
 */
import { metrics } from "@opentelemetry/api";
import type { Counter, Gauge, Histogram, Meter } from "@opentelemetry/api";
import type { ConfirmationPath, TerminalOutcome } from "../tx/confirmation.js";

export interface Metrics {
  /** Per-endpoint request latency (ms) with success/failure outcome. */
  recordRequest(endpoint: string, method: string, latencyMs: number, ok: boolean): void;
  /** A request was rate-limited (HTTP 429). */
  recordRateLimited(endpoint: string): void;
  /** A transaction was (re)broadcast to the network. */
  recordRebroadcast(signature: string): void;
  /** Terminal transaction outcome; `via` = which racer delivered it (issue #10). */
  recordLanding(signature: string, outcome: TerminalOutcome, slots: number, via?: ConfirmationPath): void;
  /** Observed slot for an endpoint (drives slot-lag dashboards). */
  recordSlot(endpoint: string, slot: bigint): void;
}

/** Trivial, fully-implemented metrics sink for tests and local debugging. */
export class InMemoryMetrics implements Metrics {
  readonly requests: Array<{ endpoint: string; method: string; latencyMs: number; ok: boolean }> = [];
  readonly rateLimited: string[] = [];
  readonly rebroadcasts: string[] = [];
  readonly landings: Array<{ signature: string; outcome: TerminalOutcome; slots: number; via?: ConfirmationPath }> = [];
  readonly slots: Array<{ endpoint: string; slot: bigint }> = [];

  recordRequest(endpoint: string, method: string, latencyMs: number, ok: boolean): void {
    this.requests.push({ endpoint, method, latencyMs, ok });
  }
  recordRateLimited(endpoint: string): void {
    this.rateLimited.push(endpoint);
  }
  recordRebroadcast(signature: string): void {
    this.rebroadcasts.push(signature);
  }
  recordLanding(signature: string, outcome: TerminalOutcome, slots: number, via?: ConfirmationPath): void {
    this.landings.push({ signature, outcome, slots, via });
  }
  recordSlot(endpoint: string, slot: bigint): void {
    this.slots.push({ endpoint, slot });
  }

  /** Convenience aggregations the diagnostics CLI / dashboard will reuse. */
  successRate(): number {
    if (this.requests.length === 0) return 1;
    return this.requests.filter((r) => r.ok).length / this.requests.length;
  }
}

export interface OtelMetricsConfig {
  serviceName?: string;
  /** OTLP endpoint, e.g. a Datadog Agent or OTel Collector. */
  otlpEndpoint?: string;
  /** Inject a Meter for tests; defaults to the global OTel meter. */
  meter?: Meter;
}

/** OpenTelemetry/Datadog-backed metrics. Bridges {@link Metrics} to OTel instruments. */
export class OtelMetrics implements Metrics {
  private readonly latency: Histogram;
  private readonly failures: Counter;
  private readonly rateLimited: Counter;
  private readonly rebroadcasts: Counter;
  private readonly landings: Counter;
  private readonly slot: Gauge;

  constructor(config?: OtelMetricsConfig) {
    const meter = config?.meter ?? metrics.getMeter(config?.serviceName ?? "solana-resilience-kit");
    this.latency = meter.createHistogram("rpc.request.latency_ms");
    this.failures = meter.createCounter("rpc.request.failures");
    this.rateLimited = meter.createCounter("rpc.rate_limited");
    this.rebroadcasts = meter.createCounter("tx.rebroadcasts");
    this.landings = meter.createCounter("tx.landings");
    this.slot = meter.createGauge("rpc.endpoint.slot");
  }

  recordRequest(endpoint: string, method: string, latencyMs: number, ok: boolean): void {
    this.latency.record(latencyMs, { endpoint, method, ok });
    if (!ok) this.failures.add(1, { endpoint, method });
  }
  recordRateLimited(endpoint: string): void {
    this.rateLimited.add(1, { endpoint });
  }
  recordRebroadcast(signature: string): void {
    this.rebroadcasts.add(1, { signature });
  }
  recordLanding(signature: string, outcome: TerminalOutcome, slots: number, via?: ConfirmationPath): void {
    // Omit `via` (rather than record "undefined") for pre-attribution callers.
    this.landings.add(1, via === undefined ? { signature, outcome, slots } : { signature, outcome, slots, via });
  }
  recordSlot(endpoint: string, slot: bigint): void {
    // Slots are well within Number.MAX_SAFE_INTEGER; gauges take numbers.
    this.slot.record(Number(slot), { endpoint });
  }
}
