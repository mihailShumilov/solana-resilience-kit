/**
 * Lifecycle events — the SDK emits the same internal signals to a typed,
 * browser-safe `LifecycleEmitter` (for dApp UIs) that it reports to
 * OpenTelemetry (for infra). Subscribe once and render live
 * "pending → sent → confirmed" plus connection state (failover / health) without
 * re-deriving any of it. A throwing listener is isolated, so a buggy UI handler
 * can never break the send path.
 */
import { ResilientRpcPool, TransactionSender, LifecycleEmitter } from "solana-resilience-kit";
import { MockCluster, MockEndpoint, MockSubscriptions } from "solana-resilience-kit/testing";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialBlockHeight: 900n });
  // Primary rate-limits every request (429); the backup is healthy.
  const flaky = new MockEndpoint(cluster, { name: "rpc-a", faults: { rate429Rate: 1 } });
  const healthy = new MockEndpoint(cluster, { name: "rpc-b" });
  // A confirmation WebSocket that errors on subscribe: the tracker falls back
  // to polling and reports the disconnect as a transaction:ws-fallback event.
  const subs = new MockSubscriptions();
  subs.failSubscription("evt-tx");

  // One emitter, shared by the pool (connection:*) and the sender (transaction:*).
  const events = new LifecycleEmitter();
  const stream: string[] = [];
  events.on("transaction:pending", () => stream.push("transaction:pending"));
  events.on("transaction:sent", () => stream.push("transaction:sent"));
  // `via` attributes the confirmation to the WS fast-path or the poll loop.
  events.on("transaction:confirmed", (p) => stream.push(`transaction:confirmed (slot ${p.slot}, via ${p.via})`));
  events.on("transaction:failed", () => stream.push("transaction:failed"));
  events.on("transaction:expired", () => stream.push("transaction:expired"));
  events.on("transaction:ws-fallback", (p) => stream.push(`transaction:ws-fallback (${p.reason})`));
  events.on("connection:failover", (p) => stream.push(`connection:failover (${p.from}→${p.to})`));
  events.on("connection:health", (p) => stream.push(`connection:health (${p.endpoint} healthy=${p.healthy})`));

  const pool = new ResilientRpcPool({
    endpoints: [
      { name: flaky.name, transport: flaky.transport },
      { name: healthy.name, transport: healthy.transport },
    ],
    freshnessAware: false, // try primary first so the 429 forces a visible failover
    events,
  });
  const sleep = async () => cluster.advanceSlots(1);
  const sender = new TransactionSender(pool.rpc(), { sleep, events, subscriptions: subs });

  log("sending through a 429 primary with a shared LifecycleEmitter attached…");
  const res = await sender.sendAndConfirm({
    wireTransaction: "evt-tx",
    signature: "evt-tx",
    lastValidBlockHeight: cluster.blockHeight + 50n,
  });
  for (const e of stream) log(`event · ${e}`);

  return {
    logs,
    result: {
      outcome: res.outcome,
      "events emitted": stream.length,
      "saw failover": stream.some((e) => e.startsWith("connection:failover")),
      "saw ws-fallback": stream.some((e) => e.startsWith("transaction:ws-fallback")),
      "lifecycle order": stream
        .filter((e) => e.startsWith("transaction:"))
        .map((e) => e.split(" ")[0]!.replace("transaction:", ""))
        .join(" → "),
    },
  };
}
