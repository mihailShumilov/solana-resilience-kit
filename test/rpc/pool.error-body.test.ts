/**
 * SPEC (red until implemented): the pool must fail over on a JSON-RPC error
 * BODY, not only on a thrown transport error (issue #19).
 *
 * A node reporting "behind by 1500 slots" answers HTTP 200 with an `error`
 * member. Before this fix the pool returned that response verbatim: no
 * failover, `recordSuccess` on the health monitor, a SUCCESS in the metrics
 * sink, and `health()` reporting the lagging node as healthy. The error only
 * surfaced later, from kit's API layer — outside the failover loop, after the
 * pool had already committed to that endpoint.
 *
 * This is the failure class MOST likely to be answerable by a different
 * endpoint: a network error is often correlated across providers, but
 * "this node is 1500 slots behind" is by definition not.
 */
import { describe, it, expect } from "vitest";
import { ResilientRpcPool } from "../../src/rpc/pool.js";
import { HealthMonitor } from "../../src/rpc/health.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { RpcNodeStateError } from "../../src/errors.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("ResilientRpcPool JSON-RPC error bodies (issue #19)", () => {
  it("fails over to the next endpoint when a node reports it is behind", async () => {
    const cluster = new MockCluster({ initialSlot: 4_242n });
    const metrics = new InMemoryMetrics();
    const behind = new MockEndpoint(cluster, {
      name: "behind",
      faults: { jsonRpcError: { code: -32005, message: "Node is unhealthy; behind by 1500 slots" } },
    });
    const healthy = new MockEndpoint(cluster, { name: "healthy" });

    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "behind", transport: behind.transport },
        { name: "healthy", transport: healthy.transport },
      ],
      freshnessAware: false,
      metrics,
    });

    // Previously: threw, having contacted only `behind`.
    expect(await pool.rpc().getSlot().send()).toBe(4_242n);
    expect(healthy.stats.requests).toBeGreaterThan(0);
  });

  it("records the error body as a FAILURE in health and metrics", async () => {
    const cluster = new MockCluster({ initialSlot: 500n });
    const metrics = new InMemoryMetrics();
    const behind = new MockEndpoint(cluster, {
      name: "behind",
      faults: { jsonRpcError: { code: -32005, message: "Node is unhealthy; behind by 1500 slots" } },
    });
    const healthy = new MockEndpoint(cluster, { name: "healthy" });

    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "behind", transport: behind.transport },
        { name: "healthy", transport: healthy.transport },
      ],
      freshnessAware: false,
      metrics,
      healthMonitor: new HealthMonitor({ endpointNames: ["behind", "healthy"], failureThreshold: 1 }),
    });

    await pool.rpc().getSlot().send();

    const behindRequests = metrics.requests.filter((r) => r.endpoint === "behind");
    expect(behindRequests).toHaveLength(1);
    expect(behindRequests[0]?.ok).toBe(false); // was `true` — a silent success
    const snap = pool.health().find((h) => h.name === "behind");
    expect(snap?.healthy).toBe(false);
    expect(snap?.errorRate).toBeGreaterThan(0);
    expect(snap?.lastError).toBeInstanceOf(RpcNodeStateError);
  });

  it("ejects a persistently-behind node so it stops costing traffic", async () => {
    const cluster = new MockCluster({ initialSlot: 600n });
    const behind = new MockEndpoint(cluster, {
      name: "behind",
      faults: { jsonRpcError: { code: -32004, message: "Block not available for slot 600" } },
    });
    const healthy = new MockEndpoint(cluster, { name: "healthy" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "behind", transport: behind.transport },
        { name: "healthy", transport: healthy.transport },
      ],
      freshnessAware: false,
      healthMonitor: new HealthMonitor({
        endpointNames: ["behind", "healthy"],
        failureThreshold: 1,
        ejectionMs: 30_000,
      }),
    });

    for (let i = 0; i < 5; i++) await pool.rpc().getSlot().send();
    expect(behind.stats.requests).toBe(1); // contacted once, then the circuit opened
    expect(pool.health().find((h) => h.name === "behind")?.ejected).toBe(true);
  });

  it("gives a body-reported rate limit the longer 429 cooldown", async () => {
    const cluster = new MockCluster({ initialSlot: 700n });
    const metrics = new InMemoryMetrics();
    const limited = new MockEndpoint(cluster, {
      name: "limited",
      faults: { jsonRpcError: { code: 429, message: "Too Many Requests" } },
    });
    const healthy = new MockEndpoint(cluster, { name: "healthy" });

    let clock = 0;
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "limited", transport: limited.transport },
        { name: "healthy", transport: healthy.transport },
      ],
      freshnessAware: false,
      metrics,
      now: () => clock,
      healthMonitor: new HealthMonitor({
        endpointNames: ["limited", "healthy"],
        failureThreshold: 1,
        ejectionMs: 30_000,
        rateLimitEjectionMs: 300_000,
        now: () => clock,
      }),
    });

    await pool.rpc().getSlot().send();
    expect(metrics.rateLimited).toContain("limited");

    clock += 30_001; // an ordinary error would be back in rotation by now
    await pool.rpc().getSlot().send();
    expect(limited.stats.requests).toBe(1);
  });

  it("does NOT fail over on a caller fault — every endpoint would repeat it", async () => {
    const cluster = new MockCluster({ initialSlot: 800n });
    const metrics = new InMemoryMetrics();
    const strict = new MockEndpoint(cluster, {
      name: "strict",
      faults: { jsonRpcError: { code: -32602, message: "Invalid params: unsupported commitment" } },
    });
    const other = new MockEndpoint(cluster, { name: "other" });

    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "strict", transport: strict.transport },
        { name: "other", transport: other.transport },
      ],
      freshnessAware: false,
      metrics,
      healthMonitor: new HealthMonitor({ endpointNames: ["strict", "other"], failureThreshold: 1 }),
    });

    // The body is returned verbatim and kit's API layer throws it, exactly as
    // before — but the endpoint is NOT blamed for our bad request.
    await expect(pool.rpc().getSlot().send()).rejects.toThrow();
    expect(other.stats.requests).toBe(0);
    expect(pool.health().find((h) => h.name === "strict")?.healthy).toBe(true);
    expect(metrics.requests.filter((r) => r.endpoint === "strict" && !r.ok)).toHaveLength(0);
  });

  it("catches an error body on the freshness probe path too", async () => {
    const cluster = new MockCluster({ initialSlot: 900n });
    const metrics = new InMemoryMetrics();
    const behind = new MockEndpoint(cluster, {
      name: "behind",
      faults: { jsonRpcError: { code: -32005, message: "Node is unhealthy; behind by 900 slots" } },
    });
    const healthy = new MockEndpoint(cluster, { name: "healthy" });

    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "behind", transport: behind.transport },
        { name: "healthy", transport: healthy.transport },
      ],
      freshnessAware: true, // probes run first
      metrics,
    });

    expect(await pool.rpc().getSlot().send()).toBe(900n);
    // The probe detected it, so the degradation reaches the Metrics sink even
    // though real traffic was routed away from it (the issue #9 guarantee).
    const behindRequests = metrics.requests.filter((r) => r.endpoint === "behind");
    expect(behindRequests.length).toBeGreaterThan(0);
    expect(behindRequests.every((r) => r.ok === false)).toBe(true);
  });
});
