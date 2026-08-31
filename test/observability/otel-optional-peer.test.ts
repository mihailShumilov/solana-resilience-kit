/**
 * SPEC (red until implemented): `@opentelemetry/api` is declared an OPTIONAL
 * peer, so nothing reachable from the package barrel may import it as a VALUE
 * at module scope (issue #15).
 *
 * `dist/observability/metrics.js` did `import { metrics } from
 * "@opentelemetry/api"` and `dist/index.js` re-exported that module, so under
 * pnpm's strict node-linker importing ANYTHING from the barrel threw
 * ERR_MODULE_NOT_FOUND before a line of user code ran — including for
 * consumers who only ever touch `InMemoryMetrics`, or no metrics at all. The
 * failure looked like a broken package, not a missing optional peer.
 *
 * The mock below makes the specifier unresolvable, exactly like the package
 * not being installed.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@opentelemetry/api", () => {
  throw new Error("ERR_MODULE_NOT_FOUND: Cannot find package '@opentelemetry/api'");
});

describe("optional @opentelemetry/api peer (issue #15)", () => {
  it("imports the package barrel with @opentelemetry/api unresolvable", async () => {
    const kit = await import("../../src/index.js");
    expect(typeof kit.ResilientRpcPool).toBe("function");
    expect(typeof kit.TransactionSender).toBe("function");
    expect(typeof kit.InMemoryMetrics).toBe("function");
  });

  it("runs the metrics sink a consumer without OTel actually uses", async () => {
    const { InMemoryMetrics } = await import("../../src/observability/metrics.js");
    const m = new InMemoryMetrics();
    m.recordRequest("a", "getSlot", 5, true);
    m.recordRequest("a", "getSlot", 5, false);
    expect(m.successRate()).toBe(0.5);
  });

  it("still constructs OtelMetrics, degrading to a no-op meter", async () => {
    const { OtelMetrics } = await import("../../src/observability/metrics.js");
    const m = new OtelMetrics({ serviceName: "svc" });
    expect(() => {
      m.recordRequest("a", "getSlot", 1, true);
      m.recordRequest("a", "getSlot", 2, false);
      m.recordRateLimited("a");
      m.recordRebroadcast("sig");
      m.recordLanding("sig", "confirmed", 3, "poll");
      m.recordSlot("a", 7n);
    }).not.toThrow();
  });

  it("drives a pool end-to-end with no OTel present", async () => {
    const { ResilientRpcPool } = await import("../../src/index.js");
    const { MockCluster, MockEndpoint } = await import("../harness/index.js");
    const cluster = new MockCluster({ initialSlot: 42n });
    const ep = new MockEndpoint(cluster, { name: "only" });
    const pool = new ResilientRpcPool({ endpoints: [{ name: "only", transport: ep.transport }] });
    expect(await pool.rpc().getSlot().send()).toBe(42n);
  });
});
