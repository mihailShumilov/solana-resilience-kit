/**
 * JSON-RPC error bodies — the failure that looks like a success. A Solana node
 * that is behind, or has pruned the block you asked for, does not return an
 * HTTP error. It returns **200 OK with a JSON-RPC `error` body**. Transports
 * only throw on a bad status, so a naive pool hands that straight back: no
 * failover, and the lagging node still counted as healthy.
 *
 * The pool inspects the body. Codes that describe the NODE become real
 * failures — failover, health, ejection — while caller faults like
 * "invalid params" are left alone, because every endpoint would repeat them.
 */
import { ResilientRpcPool, HealthMonitor, InMemoryMetrics } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialSlot: 310_000_000n });
  // HTTP 200, but the payload says the node cannot serve you.
  const behind = new MockEndpoint(cluster, {
    name: "rpc-behind",
    faults: { jsonRpcError: { code: -32005, message: "Node is unhealthy; behind by 1500 slots" } },
  });
  const healthy = new MockEndpoint(cluster, { name: "rpc-healthy" });

  const metrics = new InMemoryMetrics();
  const pool = new ResilientRpcPool({
    endpoints: [
      { name: behind.name, transport: behind.transport },
      { name: healthy.name, transport: healthy.transport },
    ],
    freshnessAware: false,
    metrics,
    healthMonitor: new HealthMonitor({
      endpointNames: [behind.name, healthy.name],
      failureThreshold: 1,
      ejectionMs: 30_000,
    }),
  });

  log("getSlot() — the primary answers 200 OK with a JSON-RPC error body…");
  const slot = await pool.rpc().getSlot().send();
  log('body said "behind by 1500 slots" → treated as a failure, not a result');
  log(`failed over; slot ${slot} served by the healthy node`);

  const snap = pool.health().find((h) => h.name === behind.name);
  const before = behind.stats.requests;
  for (let i = 0; i < 5; i++) await pool.rpc().getSlot().send();
  log(`5 more reads: the behind node was contacted ${behind.stats.requests - before} more times`);

  return {
    logs,
    result: {
      "served slot": Number(slot),
      "served by": metrics.requests.find((r) => r.ok)?.endpoint ?? "—",
      "error bodies returned": behind.stats.errorBodies,
      // Previously this row read `true` — the whole point of the bug.
      "behind node healthy": Boolean(snap?.healthy),
      "behind node ejected": Boolean(snap?.ejected),
      "recorded as a failure": metrics.requests.some((r) => r.endpoint === behind.name && !r.ok),
    },
  };
}
