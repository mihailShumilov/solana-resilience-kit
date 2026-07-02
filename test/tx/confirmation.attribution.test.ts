/**
 * SPEC (red until implemented): confirmation path attribution (issue #10).
 *
 * The WS fast-path races the poll loop, but nothing records which path won —
 * so WS latency benefit, polling fallback rate, and disconnects are not
 * derivable. TrackResult gains `via: "ws" | "poll"`, the sender threads it
 * into the `transaction:confirmed` / landed-but-failed `transaction:failed`
 * payloads and `recordLanding`, and a genuine subscription failure emits one
 * `transaction:ws-fallback` event. Losing the race is NOT a fallback, and
 * attribution never alters an outcome.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { ConfirmationTracker } from "../../src/tx/confirmation.js";
import { TransactionSender } from "../../src/tx/sender.js";
import { LifecycleEmitter } from "../../src/events.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { MockCluster, MockEndpoint, MockSubscriptions } from "../harness/index.js";

function setup() {
  const cluster = new MockCluster({ initialBlockHeight: 500n });
  const ep = new MockEndpoint(cluster);
  const rpc = createSolanaRpcFromTransport(ep.transport);
  const subs = new MockSubscriptions();
  const events = new LifecycleEmitter();
  const fallbacks: Array<{ signature: string; reason: string }> = [];
  events.on("transaction:ws-fallback", (p) => fallbacks.push(p));
  const sleep = async () => {
    cluster.advanceSlots(1);
  };
  return { cluster, ep, rpc, subs, events, fallbacks, sleep };
}

/** Flush a few microtasks so any late (buggy) emit would be observed. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ConfirmationTracker path attribution (issue #10)", () => {
  it("reports via 'ws' when the subscription delivers the confirmation", async () => {
    const { rpc, subs, events, fallbacks, sleep } = setup();
    subs.notify("SigViaWs", { err: null, slot: 42n });
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs, events });

    const res = await tracker.track({ signature: "SigViaWs", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(res.via).toBe("ws");
    await flush();
    expect(fallbacks).toHaveLength(0); // WS winning is not a fallback
  });

  it("reports via 'ws' on a WS-delivered landed-but-failed outcome", async () => {
    const { rpc, subs, events, sleep } = setup();
    const onChainErr = { InstructionError: [0, { Custom: 42 }] };
    subs.notify("SigViaWsErr", { err: onChainErr, slot: 7n });
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs, events });

    const res = await tracker.track({ signature: "SigViaWsErr", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("failed");
    expect(res.via).toBe("ws");
  });

  it("reports via 'poll' when the poll loop wins against a silent-but-open stream", async () => {
    const { cluster, rpc, subs, events, fallbacks, sleep } = setup();
    cluster.rpcSendTransaction("SigViaPoll"); // lands via the poll path
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs, events });

    const res = await tracker.track({ signature: "SigViaPoll", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(res.via).toBe("poll");
    // The stream neither errored nor closed — losing the race is not a fallback.
    await flush();
    expect(fallbacks).toHaveLength(0);
  });

  it("emits exactly one transaction:ws-fallback when subscribe() rejects", async () => {
    const { cluster, rpc, subs, events, fallbacks, sleep } = setup();
    subs.failSubscription("SigSubErr");
    cluster.rpcSendTransaction("SigSubErr");
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs, events });

    const res = await tracker.track({ signature: "SigSubErr", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(res.via).toBe("poll");
    await flush();
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.signature).toBe("SigSubErr");
    expect(fallbacks[0]?.reason.length).toBeGreaterThan(0);
  });

  it("emits one transaction:ws-fallback when the stream closes without delivering", async () => {
    const { cluster, rpc, subs, events, fallbacks, sleep } = setup();
    cluster.rpcSendTransaction("SigStreamClose");
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs, events });

    const trackPromise = tracker.track({ signature: "SigStreamClose", lastValidBlockHeight: 650n });
    await Promise.resolve();
    subs.endStream("SigStreamClose"); // disconnect before any notification

    const res = await trackPromise;
    expect(res.outcome).toBe("confirmed");
    expect(res.via).toBe("poll");
    await flush();
    expect(fallbacks).toHaveLength(1);
  });

  it("reports via 'poll' on expiry even with a subscription configured", async () => {
    const { cluster, rpc, subs, events, sleep } = setup();
    cluster.scheduleLanding("SigNever", -1); // never lands
    cluster.rpcSendTransaction("SigNever");
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs, events });

    const res = await tracker.track({ signature: "SigNever", lastValidBlockHeight: 505n });

    expect(res.outcome).toBe("expired");
    expect(res.via).toBe("poll");
  });

  it("pure polling reports via 'poll' and emits no subscription events", async () => {
    const { cluster, rpc, events, fallbacks, sleep } = setup();
    cluster.rpcSendTransaction("SigPure");
    const tracker = new ConfirmationTracker(rpc, { sleep, events }); // no subscriptions

    const res = await tracker.track({ signature: "SigPure", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(res.via).toBe("poll");
    await flush();
    expect(fallbacks).toHaveLength(0);
  });
});

describe("TransactionSender path attribution (issue #10)", () => {
  it("threads via 'ws' into the confirmed event payload and recordLanding", async () => {
    const { rpc, subs, events, sleep } = setup();
    const metrics = new InMemoryMetrics();
    const confirmed: Array<{ via?: "ws" | "poll" }> = [];
    events.on("transaction:confirmed", (p) => confirmed.push(p));
    subs.notify("SigSenderWs", { err: null, slot: 9n });
    const sender = new TransactionSender(rpc, { sleep, events, metrics, subscriptions: subs });

    const res = await sender.sendAndConfirm({
      wireTransaction: "SigSenderWs",
      signature: "SigSenderWs",
      lastValidBlockHeight: 650n,
    });

    expect(res.outcome).toBe("confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.via).toBe("ws");
    expect(metrics.landings).toHaveLength(1);
    expect(metrics.landings[0]?.via).toBe("ws");
  });

  it("threads via 'poll' when the sender confirms by polling (no subscriptions)", async () => {
    const { rpc, events, sleep } = setup();
    const metrics = new InMemoryMetrics();
    const confirmed: Array<{ via?: "ws" | "poll" }> = [];
    events.on("transaction:confirmed", (p) => confirmed.push(p));
    const sender = new TransactionSender(rpc, { sleep, events, metrics });

    await sender.sendAndConfirm({
      wireTransaction: "SigSenderPoll",
      signature: "SigSenderPoll",
      lastValidBlockHeight: 650n,
    });

    expect(confirmed[0]?.via).toBe("poll");
    expect(metrics.landings[0]?.via).toBe("poll");
  });
});
