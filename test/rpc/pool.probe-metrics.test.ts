/**
 * SPEC (red until implemented): probe-detected degradation must reach the
 * Metrics sink, not only health() (issue #9). When freshness-aware routing
 * probes an endpoint and the probe fails, the pool records a failed request
 * (and a rate-limit event for a 429) so OTel dashboards keyed off
 * rpc.request failures / rpc.rate_limited see the endpoint degrade even
 * though real traffic is routed away from it. Successful probes stay OUT of
 * recordRequest so synthetic probe traffic never inflates success counts.
 */
import { describe, it, expect } from "vitest";
import { ResilientRpcPool } from "../../src/rpc/pool.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("ResilientRpcPool probe metrics (issue #9)", () => {
  it("records a failed request when the freshness probe detects a dead endpoint", async () => {
    const cluster = new MockCluster({ initialSlot: 500n });
    const metrics = new InMemoryMetrics();
    const bad = new MockEndpoint(cluster, { name: "bad", faults: { errorRate: 1 } });
    const good = new MockEndpoint(cluster, { name: "good" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "bad", transport: bad.transport },
        { name: "good", transport: good.transport },
      ],
      metrics,
    });

    // The bad endpoint fails its probe, is ranked out, and never serves the
    // real request — previously leaving the metrics sink blind to it.
    expect(await pool.rpc().getSlot().send()).toBe(500n);

    const badRequests = metrics.requests.filter((r) => r.endpoint === "bad");
    expect(badRequests.length).toBeGreaterThan(0);
    expect(badRequests.every((r) => r.ok === false)).toBe(true);
    expect(badRequests.every((r) => r.method === "getSlot")).toBe(true);
    // The degradation is also (still) visible via health(). One probe is one
    // failure — the healthy flag itself only flips at failureThreshold (3).
    expect(pool.health().find((h) => h.name === "bad")?.consecutiveFailures).toBeGreaterThan(0);
  });

  it("records a rate-limit event when the probe is 429ed", async () => {
    const cluster = new MockCluster();
    const metrics = new InMemoryMetrics();
    const limited = new MockEndpoint(cluster, { name: "limited", faults: { rate429Rate: 1 } });
    const good = new MockEndpoint(cluster, { name: "good" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "limited", transport: limited.transport },
        { name: "good", transport: good.transport },
      ],
      metrics,
    });

    await pool.rpc().getSlot().send();

    expect(metrics.rateLimited).toContain("limited");
    const limitedRequests = metrics.requests.filter((r) => r.endpoint === "limited");
    expect(limitedRequests.length).toBeGreaterThan(0);
    expect(limitedRequests.every((r) => r.ok === false)).toBe(true);
  });

  it("does not inflate request metrics with successful probe traffic", async () => {
    const cluster = new MockCluster();
    const metrics = new InMemoryMetrics();
    const a = new MockEndpoint(cluster, { name: "a" });
    const b = new MockEndpoint(cluster, { name: "b" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "a", transport: a.transport },
        { name: "b", transport: b.transport },
      ],
      metrics,
    });

    await pool.rpc().getSlot().send();

    // Both endpoints were probed successfully, but only the ONE real served
    // request may appear in recordRequest — probe successes are synthetic
    // traffic and must not pad success counts / error-rate denominators.
    expect(metrics.requests).toHaveLength(1);
    expect(metrics.requests[0]?.ok).toBe(true);
  });
});
