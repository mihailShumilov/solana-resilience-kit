/**
 * SPEC (red until implemented): the package entry point re-exports the
 * transport types a consumer needs to type a `ResilientRpcPool` config —
 * without reaching into `@solana/rpc-spec`, which is NOT a dependency a
 * consumer can resolve under pnpm's strict node-linker (issue #8). The only
 * packages a consumer may be asked to import from are this kit and its peer
 * `@solana/kit`.
 */
import { describe, it, expect } from "vitest";
import { ResilientRpcPool } from "../../src/index.js";
import type { RpcTransport, ResilientEndpoint, ResilientRpcConfig } from "../../src/index.js";
import type { RpcTransport as KitRpcTransport } from "@solana/kit";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("public type surface (issue #8)", () => {
  it("types an endpoints array end-to-end using only entry-point imports", async () => {
    const cluster = new MockCluster({ initialSlot: 77n });
    const endpoint = new MockEndpoint(cluster, { name: "primary" });

    // A consumer builds the config with types imported ONLY from the entry
    // point. If `RpcTransport` stops being exported (or drifts from the type
    // the pool config expects), this file fails `tsc --noEmit`.
    const transport: RpcTransport = endpoint.transport;
    const endpoints: ResilientEndpoint[] = [{ name: "primary", transport }];
    const config: ResilientRpcConfig = { endpoints };

    const pool = new ResilientRpcPool(config);
    expect(await pool.rpc().getSlot().send()).toBe(77n);
  });

  it("re-exported RpcTransport is the @solana/kit type, not a lookalike", () => {
    // Mutual assignability with the peer-dependency type: a transport typed
    // via `@solana/kit` is accepted, and ours satisfies kit APIs. Compile-time
    // only; the runtime assertion just anchors the test.
    const fromKit = null as unknown as KitRpcTransport;
    const ours: RpcTransport = fromKit;
    const roundTrip: KitRpcTransport = ours;
    expect(roundTrip).toBe(fromKit);
  });

  it("pool.transport satisfies the re-exported RpcTransport type", () => {
    const cluster = new MockCluster();
    const endpoint = new MockEndpoint(cluster, { name: "only" });
    const pool = new ResilientRpcPool({ endpoints: [{ name: "only", transport: endpoint.transport }] });
    const asTransport: RpcTransport = pool.transport;
    expect(typeof asTransport).toBe("function");
  });
});
