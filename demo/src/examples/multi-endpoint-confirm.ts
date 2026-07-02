/**
 * Multi-endpoint + WebSocket confirmation — a single lagging node can withhold a
 * signature status and make a tx look unconfirmed. `ConfirmationTracker` can fan
 * status polling out across the freshest healthy endpoints (a definitive result
 * from ANY node wins; dead nodes are tolerated), and can ALSO race a
 * `signatureNotifications` WebSocket fast-path alongside the poll loop — whichever
 * fires first wins, while the poll loop stays the sole authority for expiry.
 */
import { ConfirmationTracker, HealthMonitor } from "solana-resilience-kit";
import { MockCluster, MockEndpoint, MockSubscriptions } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport, type Base64EncodedWireTransaction } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  // ---- Part 1: multi-endpoint fan-out --------------------------------------
  const cluster = new MockCluster({ initialBlockHeight: 500n });
  const dead = new MockEndpoint(cluster, { name: "rpc-a", faults: { offline: true } });
  const b = new MockEndpoint(cluster, { name: "rpc-b" });
  const c = new MockEndpoint(cluster, { name: "rpc-c" });
  const rpcOf = (e: MockEndpoint) => createSolanaRpcFromTransport(e.transport);

  // In a real app this is the pool's own HealthMonitor, already populated from
  // live traffic. Here we seed a few observations: rpc-a is failing (ejected),
  // rpc-b / rpc-c are fresh — so status polling routes to the healthy nodes.
  const hm = new HealthMonitor({ endpointNames: ["rpc-a", "rpc-b", "rpc-c"] });
  hm.recordSuccess("rpc-b", 20, cluster.slot);
  hm.recordSuccess("rpc-c", 25, cluster.slot);
  for (let i = 0; i < 3; i++) hm.recordFailure("rpc-a", new Error("offline"));

  const sig = "fanout-sig";
  cluster.scheduleLanding(sig, 2); // lands two slots after broadcast
  await rpcOf(b).sendTransaction(sig as unknown as Base64EncodedWireTransaction, { encoding: "base64" }).send();

  const tracker = new ConfirmationTracker(rpcOf(b), {
    sleep: async () => cluster.advanceSlots(1),
    multiEndpoint: {
      endpoints: [
        { name: "rpc-a", rpc: rpcOf(dead) },
        { name: "rpc-b", rpc: rpcOf(b) },
        { name: "rpc-c", rpc: rpcOf(c) },
      ],
      healthMonitor: hm,
      k: 3,
    },
  });
  log("polling status across the freshest healthy endpoints (rpc-a is dead)…");
  const fanout = await tracker.track({ signature: sig, lastValidBlockHeight: 700n });
  log(`fan-out outcome: ${fanout.outcome} after ${fanout.polls} poll round(s)`);

  // ---- Part 2: WebSocket fast-path -----------------------------------------
  const cluster2 = new MockCluster({ initialBlockHeight: 500n });
  const ep = new MockEndpoint(cluster2, { name: "rpc" });
  const subs = new MockSubscriptions();
  const wsSig = "ws-sig";
  // A signatureNotifications event arrives over the socket (err == null → ok).
  subs.notify(wsSig, { slot: 318_244_512n });

  const wsTracker = new ConfirmationTracker(createSolanaRpcFromTransport(ep.transport), {
    sleep: async () => cluster2.advanceSlots(1),
    subscriptions: subs,
  });
  log("racing a signatureNotifications WebSocket alongside the poll loop…");
  const ws = await wsTracker.track({ signature: wsSig, lastValidBlockHeight: 700n });
  log(`WS fast-path outcome: ${ws.outcome} via ${ws.via} with ${ws.polls} status poll(s)`);

  return {
    logs,
    result: {
      "fan-out outcome": fanout.outcome,
      "tolerated dead node": fanout.outcome === "confirmed",
      "ws outcome": ws.outcome,
      // TrackResult.via attributes the outcome to whichever racer delivered it
      // ("ws" | "poll") — chart WS latency wins vs polling fallbacks.
      "ws delivered via": ws.via,
      "ws landed slot": ws.slot === null ? "—" : Number(ws.slot),
      "ws status polls": ws.polls, // 0 → the socket resolved before any poll
    },
  };
}
