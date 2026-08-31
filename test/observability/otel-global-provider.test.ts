/**
 * SPEC (red until implemented): dropping the static `@opentelemetry/api`
 * import (issue #15) must NOT silently turn `new OtelMetrics()` into a
 * permanent no-op. The documented zero-config path — the host app registers a
 * global MeterProvider with `metrics.setGlobalMeterProvider(...)`, exactly as
 * `examples/otel-setup.ts` does — has to keep exporting.
 *
 * This test uses the real `@opentelemetry/api` (a devDependency here) to
 * register the provider, so it verifies interoperability with the actual
 * package rather than a re-implementation of it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { metrics as otelApi } from "@opentelemetry/api";
import type { Meter, MeterProvider } from "@opentelemetry/api";
import { OtelMetrics } from "../../src/observability/metrics.js";

interface Call {
  value: number;
  attributes?: Record<string, unknown>;
}

function capturingProvider(): { provider: MeterProvider; calls: Record<string, Call[]>; names: string[] } {
  const calls: Record<string, Call[]> = {};
  const names: string[] = [];
  const instrument = (name: string) => {
    const bucket: Call[] = (calls[name] = calls[name] ?? []);
    const push = (value: number, attributes?: Record<string, unknown>): void => {
      bucket.push({ value, attributes });
    };
    return { add: push, record: push };
  };
  const meter = {
    createCounter: instrument,
    createHistogram: instrument,
    createGauge: instrument,
    createUpDownCounter: instrument,
  } as unknown as Meter;
  const provider = {
    getMeter: (name: string) => {
      names.push(name);
      return meter;
    },
  } as unknown as MeterProvider;
  return { provider, calls, names };
}

afterEach(() => {
  otelApi.disable(); // unregister the global so tests stay independent
});

describe("OtelMetrics against a globally-registered MeterProvider (issue #15)", () => {
  it("records into the global provider with no injected meter", () => {
    const { provider, calls, names } = capturingProvider();
    otelApi.setGlobalMeterProvider(provider);

    const m = new OtelMetrics({ serviceName: "my-service" });
    m.recordSlot("a", 1234n);
    m.recordRateLimited("a");

    expect(names).toContain("my-service");
    expect(calls["rpc.endpoint.slot"]?.[0]).toMatchObject({ value: 1234, attributes: { endpoint: "a" } });
    expect(calls["rpc.rate_limited"]).toHaveLength(1);
  });

  it("falls back to a no-op meter when no provider is registered", () => {
    const m = new OtelMetrics();
    expect(() => m.recordSlot("a", 1n)).not.toThrow();
  });

  it("prefers an explicitly injected meter over the global provider", () => {
    const globalSide = capturingProvider();
    otelApi.setGlobalMeterProvider(globalSide.provider);
    const injected = capturingProvider();

    const m = new OtelMetrics({ meter: injected.provider.getMeter("injected") });
    m.recordRateLimited("a");

    expect(injected.calls["rpc.rate_limited"]).toHaveLength(1);
    expect(globalSide.calls["rpc.rate_limited"] ?? []).toHaveLength(0);
  });
});
