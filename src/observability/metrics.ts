/**
 * Observability surface. The SDK emits a small, fixed set of client-side
 * signals — the metrics the ecosystem currently re-implements by hand. The
 * `Metrics` interface decouples the SDK from any backend; `InMemoryMetrics` is
 * a real implementation used by tests to assert the SDK emits the right
 * signals, and `OtelMetrics` bridges to OpenTelemetry / Datadog via the OTLP
 * exporter.
 *
 * NOTE (issue #15): this module must NOT import `@opentelemetry/api` — not as
 * a value, not as a type. It is an OPTIONAL peer, but the package barrel
 * re-exports this file, so a static import made `import "solana-resilience-kit"`
 * throw ERR_MODULE_NOT_FOUND under pnpm's strict node-linker for every
 * consumer without OTel installed — including those who only wanted
 * `InMemoryMetrics`. The instrument types below are therefore declared
 * structurally: a real OTel `Meter` satisfies {@link OtelMeterLike}, and the
 * global `MeterProvider` an app registers with
 * `metrics.setGlobalMeterProvider()` is read out of OTel's own global registry
 * without ever importing the package.
 */
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

/** Attribute bag accepted by the OTel instruments this module drives. */
export type MetricAttributes = Record<string, string | number | boolean | undefined>;

/** Structural stand-in for an OTel `Counter` — a real one satisfies it. */
export interface OtelCounterLike {
  add(value: number, attributes?: MetricAttributes): void;
}

/** Structural stand-in for an OTel `Histogram` / `Gauge`. */
export interface OtelRecorderLike {
  record(value: number, attributes?: MetricAttributes): void;
}

/** Structural stand-in for an OTel `Meter` — a real one satisfies it. */
export interface OtelMeterLike {
  createCounter(name: string): OtelCounterLike;
  createHistogram(name: string): OtelRecorderLike;
  createGauge(name: string): OtelRecorderLike;
}

/** Structural stand-in for an OTel `MeterProvider`. */
export interface OtelMeterProviderLike {
  getMeter(name: string, version?: string): OtelMeterLike;
}

export interface OtelMetricsConfig {
  serviceName?: string;
  /** OTLP endpoint, e.g. a Datadog Agent or OTel Collector. */
  otlpEndpoint?: string;
  /** Inject a Meter for tests; defaults to the globally-registered OTel meter. */
  meter?: OtelMeterLike;
  /** Inject a MeterProvider instead of registering it globally. */
  meterProvider?: OtelMeterProviderLike;
}

/** Instruments that drop everything, used when no MeterProvider is registered. */
const NOOP_METER: OtelMeterLike = {
  createCounter: () => ({ add: () => {} }),
  createHistogram: () => ({ record: () => {} }),
  createGauge: () => ({ record: () => {} }),
};

/**
 * The MeterProvider the host app registered via `metrics.setGlobalMeterProvider()`.
 *
 * `@opentelemetry/api` stores it on a well-known global symbol keyed by its own
 * major version (`Symbol.for("opentelemetry.js.api.1")`), which is exactly how
 * it survives duplicate installs of the package. Reading it there gives the
 * same object `metrics.getMeterProvider()` would return, with no import — so
 * the zero-config path from `examples/otel-setup.ts` keeps working while the
 * peer stays genuinely optional (issue #15). Returns undefined when the app
 * never registered a provider, or never installed OTel at all.
 */
function globalMeterProvider(): OtelMeterProviderLike | undefined {
  const root = globalThis as unknown as Record<symbol, { metrics?: unknown } | undefined>;
  for (const sym of Object.getOwnPropertySymbols(globalThis)) {
    if (Symbol.keyFor(sym)?.startsWith("opentelemetry.js.api.") !== true) continue;
    const provider = root[sym]?.metrics;
    if (provider !== null && typeof provider === "object" && "getMeter" in provider) {
      return provider as OtelMeterProviderLike;
    }
  }
  return undefined;
}

/** OpenTelemetry/Datadog-backed metrics. Bridges {@link Metrics} to OTel instruments. */
export class OtelMetrics implements Metrics {
  private readonly latency: OtelRecorderLike;
  private readonly failures: OtelCounterLike;
  private readonly rateLimited: OtelCounterLike;
  private readonly rebroadcasts: OtelCounterLike;
  private readonly landings: OtelCounterLike;
  private readonly slot: OtelRecorderLike;

  constructor(config?: OtelMetricsConfig) {
    const meter = config?.meter ?? OtelMetrics.resolveMeter(config);
    this.latency = meter.createHistogram("rpc.request.latency_ms");
    this.failures = meter.createCounter("rpc.request.failures");
    this.rateLimited = meter.createCounter("rpc.rate_limited");
    this.rebroadcasts = meter.createCounter("tx.rebroadcasts");
    this.landings = meter.createCounter("tx.landings");
    this.slot = meter.createGauge("rpc.endpoint.slot");
  }

  /** Injected provider, else the globally-registered one, else a no-op. */
  private static resolveMeter(config?: OtelMetricsConfig): OtelMeterLike {
    const provider = config?.meterProvider ?? globalMeterProvider();
    if (provider === undefined) return NOOP_METER;
    return provider.getMeter(config?.serviceName ?? "solana-resilience-kit");
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
