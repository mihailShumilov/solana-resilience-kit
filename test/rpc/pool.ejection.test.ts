/**
 * SPEC (red until implemented): nothing may keep a failing endpoint in
 * rotation at full traffic cost (issue #17).
 *
 * Two concrete failures this pins down:
 *  1. `freshnessAware: false` ignored HealthMonitor entirely — an endpoint
 *     that failed its last 50 requests was still attempted first on #51.
 *  2. `freshnessAware: true` probed `getSlot` on EVERY endpoint for EVERY
 *     logical request — 4 requests of traffic per 1 request of work with 3
 *     endpoints, which is the opposite of what a deployment that just
 *     exhausted a provider quota can afford.
 *
 * And the invariant that makes native ejection usable: an endpoint the pool
 * CHOSE NOT TO CONTACT must not appear in the Metrics sink at all — a skip is
 * not a failed request, and must not drag the reported success rate down.
 */
import { describe, it, expect } from "vitest";
import { ResilientRpcPool } from "../../src/rpc/pool.js";
import { HealthMonitor } from "../../src/rpc/health.js";
import { AllEndpointsFailedError, EndpointEjectedError } from "../../src/errors.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe("ResilientRpcPool health-aware ordering with freshnessAware off (issue #17)", () => {
  it("stops attempting a known-bad endpoint first", async () => {
    const cluster = new MockCluster({ initialSlot: 100n });
    const bad = new MockEndpoint(cluster, { name: "bad", faults: { errorRate: 1 } });
    const good = new MockEndpoint(cluster, { name: "good" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "bad", transport: bad.transport },
        { name: "good", transport: good.transport },
      ],
      freshnessAware: false,
      // ejectionMs: 0 turns the breaker OFF, so this test isolates ORDERING:
      // the bad endpoint is still eligible, it is just no longer ranked first.
      healthMonitor: new HealthMonitor({
        endpointNames: ["bad", "good"],
        failureThreshold: 1,
        ejectionMs: 0,
      }),
    });

    expect(await pool.rpc().getSlot().send()).toBe(100n);
    expect(bad.stats.requests).toBe(1); // tried first while still believed healthy

    for (let i = 0; i < 5; i++) await pool.rpc().getSlot().send();
    expect(bad.stats.requests).toBe(1); // ranked behind `good`, which serves first
    expect(good.stats.requests).toBe(6);
  });
});

describe("ResilientRpcPool ejection window (issue #17)", () => {
  it("skips an ejected endpoint with no network call and no metrics entry", async () => {
    const cluster = new MockCluster({ initialSlot: 200n });
    const metrics = new InMemoryMetrics();
    const bad = new MockEndpoint(cluster, { name: "bad", faults: { errorRate: 1 } });
    const good = new MockEndpoint(cluster, { name: "good" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "bad", transport: bad.transport },
        { name: "good", transport: good.transport },
      ],
      freshnessAware: false,
      metrics,
      healthMonitor: new HealthMonitor({
        endpointNames: ["bad", "good"],
        failureThreshold: 1,
        ejectionMs: 30_000,
      }),
    });

    for (let i = 0; i < 4; i++) await pool.rpc().getSlot().send();

    expect(bad.stats.requests).toBe(1); // contacted once, then the circuit opened
    // A skip is NOT a failed request: exactly one metrics entry for `bad`.
    expect(metrics.requests.filter((r) => r.endpoint === "bad")).toHaveLength(1);
    expect(metrics.requests).toHaveLength(5); // 1 real failure + 4 successes
    expect(metrics.successRate()).toBeCloseTo(4 / 5);
    expect(pool.health().find((h) => h.name === "bad")?.ejected).toBe(true);
  });

  it("reports the skip as an EndpointEjectedError instead of dialling out", async () => {
    const cluster = new MockCluster();
    const metrics = new InMemoryMetrics();
    const dead = new MockEndpoint(cluster, { name: "dead", faults: { offline: true } });
    const pool = new ResilientRpcPool({
      endpoints: [{ name: "dead", transport: dead.transport }],
      freshnessAware: false,
      metrics,
      healthMonitor: new HealthMonitor({ endpointNames: ["dead"], failureThreshold: 1, ejectionMs: 30_000 }),
    });

    await expect(pool.rpc().getSlot().send()).rejects.toBeInstanceOf(AllEndpointsFailedError);
    expect(dead.stats.requests).toBe(1);

    const err = await pool
      .rpc()
      .getSlot()
      .send()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllEndpointsFailedError);
    expect((err as AllEndpointsFailedError).attempts[0]?.error).toBeInstanceOf(EndpointEjectedError);
    // Zero network cost for the second request, and no phantom failed request.
    expect(dead.stats.requests).toBe(1);
    expect(metrics.requests).toHaveLength(1);
  });

  it("half-opens after the cooldown and returns a recovered endpoint to rotation", async () => {
    const c = clock();
    const cluster = new MockCluster({ initialSlot: 300n });
    const flaky = new MockEndpoint(cluster, { name: "flaky", faults: { errorRate: 1 } });
    const good = new MockEndpoint(cluster, { name: "good" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "flaky", transport: flaky.transport },
        { name: "good", transport: good.transport },
      ],
      freshnessAware: false,
      now: c.now,
      healthMonitor: new HealthMonitor({
        endpointNames: ["flaky", "good"],
        failureThreshold: 1,
        ejectionMs: 30_000,
        now: c.now,
      }),
    });

    await pool.rpc().getSlot().send();
    expect(flaky.stats.requests).toBe(1);

    c.advance(29_000);
    await pool.rpc().getSlot().send();
    expect(flaky.stats.requests).toBe(1); // still inside the cooldown

    // The provider recovers; the cooldown expires.
    flaky.faults = {};
    c.advance(1_001);
    await pool.rpc().getSlot().send();

    // One cheap half-open probe brought it back — recovery must not require a
    // real request to be routed at a still-broken endpoint.
    expect(flaky.stats.requests).toBeGreaterThan(1);
    const health = pool.health().find((h) => h.name === "flaky");
    expect(health?.ejected).toBe(false);
    expect(health?.healthy).toBe(true);
  });

  it("does not probe an ejected endpoint on the freshness path either", async () => {
    const c = clock();
    const cluster = new MockCluster({ initialSlot: 400n });
    const dead = new MockEndpoint(cluster, { name: "dead", faults: { offline: true } });
    const good = new MockEndpoint(cluster, { name: "good" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "dead", transport: dead.transport },
        { name: "good", transport: good.transport },
      ],
      freshnessAware: true,
      healthRefreshMs: 1_000,
      now: c.now,
      healthMonitor: new HealthMonitor({
        endpointNames: ["dead", "good"],
        failureThreshold: 1,
        ejectionMs: 60_000,
        now: c.now,
      }),
    });

    await pool.rpc().getSlot().send();
    expect(dead.stats.requests).toBe(1); // one probe, then ejected

    for (let i = 0; i < 5; i++) {
      c.advance(2_000); // several freshness-refresh windows go by
      await pool.rpc().getSlot().send();
    }
    expect(dead.stats.requests).toBe(1); // ejection outranks the refresh cadence
  });
});

describe("ResilientRpcPool freshness probe gating (issue #17)", () => {
  it("probes at most once per healthRefreshMs instead of once per request", async () => {
    const c = clock();
    const cluster = new MockCluster({ initialSlot: 500n });
    const a = new MockEndpoint(cluster, { name: "a" });
    const b = new MockEndpoint(cluster, { name: "b" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "a", transport: a.transport },
        { name: "b", transport: b.transport },
      ],
      freshnessAware: true,
      healthRefreshMs: 5_000,
      now: c.now,
    });

    for (let i = 0; i < 3; i++) await pool.rpc().getSlot().send();
    // One probe round (2) + three served requests (3). The old behaviour was
    // 3 x (2 probes + 1 serve) = 9.
    expect(a.stats.requests + b.stats.requests).toBe(5);

    c.advance(5_000);
    await pool.rpc().getSlot().send();
    expect(a.stats.requests + b.stats.requests).toBe(8); // + 2 probes + 1 serve
  });

  it("keeps routing to the freshest node from the cached slot between probes", async () => {
    const c = clock();
    const cluster = new MockCluster({ initialSlot: 600n });
    const stale = new MockEndpoint(cluster, { name: "stale", faults: { slotLag: 400 } });
    const fresh = new MockEndpoint(cluster, { name: "fresh" });
    const pool = new ResilientRpcPool({
      // laggard listed first on purpose
      endpoints: [
        { name: "stale", transport: stale.transport },
        { name: "fresh", transport: fresh.transport },
      ],
      freshnessAware: true,
      healthRefreshMs: 60_000,
      now: c.now,
    });

    for (let i = 0; i < 4; i++) {
      c.advance(100);
      expect(await pool.rpc().getSlot().send()).toBe(600n); // never the lagged 200
    }
    expect(stale.stats.requests).toBe(1); // the single probe round, nothing more
    expect(fresh.stats.requests).toBe(5); // one probe + four served requests
  });
});
