/**
 * SPEC (red until implemented): the pool must count a rate-limit thrown by
 * @solana/kit's REAL HTTP transport, not just by the harness (issue #16).
 *
 * This is the reproduction from the issue: a loopback server that answers 429,
 * fronted by `createDefaultRpcTransport` — the exact wiring the README
 * documents. Nothing here touches the network beyond 127.0.0.1.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDefaultRpcTransport } from "@solana/kit";
import { ResilientRpcPool } from "../../src/rpc/pool.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A loopback JSON-RPC server that always answers `status`. */
async function serverAlways(status: number, headers: Record<string, string> = {}): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ error: "rate limited" }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("ResilientRpcPool against @solana/kit's own transport (issue #16)", () => {
  it("records a rate-limit when kit throws a SolanaError carrying context.statusCode", async () => {
    const url = await serverAlways(429, { "retry-after": "7" });
    const cluster = new MockCluster({ initialSlot: 9_000n });
    const backup = new MockEndpoint(cluster, { name: "backup" });
    const metrics = new InMemoryMetrics();

    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "throttled", transport: createDefaultRpcTransport({ url }) },
        { name: "backup", transport: backup.transport },
      ],
      freshnessAware: false,
      metrics,
    });

    expect(await pool.rpc().getSlot().send()).toBe(9_000n);
    // The counter that exists precisely to explain a quota exhaustion.
    expect(metrics.rateLimited).toContain("throttled");
  });

  it("does not count a non-429 kit error as a rate-limit", async () => {
    const url = await serverAlways(503);
    const cluster = new MockCluster({ initialSlot: 9_001n });
    const backup = new MockEndpoint(cluster, { name: "backup" });
    const metrics = new InMemoryMetrics();

    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "down", transport: createDefaultRpcTransport({ url }) },
        { name: "backup", transport: backup.transport },
      ],
      freshnessAware: false,
      metrics,
    });

    expect(await pool.rpc().getSlot().send()).toBe(9_001n);
    expect(metrics.rateLimited).toHaveLength(0);
    expect(metrics.requests.some((r) => r.endpoint === "down" && !r.ok)).toBe(true);
  });
});
