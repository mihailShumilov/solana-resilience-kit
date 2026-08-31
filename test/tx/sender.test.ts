/**
 * SPEC (red until implemented): TransactionSender is the landing state machine.
 * It must send with maxRetries:0, rebroadcast on a loop, confirm via block
 * height, give up at expiry, and NEVER mutate/re-sign the transaction.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { TransactionSender } from "../../src/tx/sender.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function setup() {
  const cluster = new MockCluster({ initialBlockHeight: 700n });
  const ep = new MockEndpoint(cluster);
  const rpc = createSolanaRpcFromTransport(ep.transport);
  const sleep = async () => {
    cluster.advanceSlots(1);
  };
  return { cluster, ep, rpc, sleep };
}

describe("TransactionSender", () => {
  it("confirms a tx that lands, rebroadcasting at least once", async () => {
    const { rpc, sleep } = setup();
    const sender = new TransactionSender(rpc, { sleep });
    // short string -> mock treats it as a raw signature
    const res = await sender.sendAndConfirm({
      wireTransaction: "SigSend1",
      signature: "SigSend1",
      lastValidBlockHeight: 800n,
    });
    expect(res.outcome).toBe("confirmed");
    expect(res.rebroadcasts).toBeGreaterThanOrEqual(1);
  });

  it("sends with maxRetries:0 (disables the RPC's own retry)", async () => {
    const { ep, rpc, sleep } = setup();
    const sender = new TransactionSender(rpc, { sleep });
    await sender.sendAndConfirm({
      wireTransaction: "SigSend2",
      signature: "SigSend2",
      lastValidBlockHeight: 800n,
    });
    // The invariant is the VALUE — the RPC's generic retry is disabled — not
    // which JS numeric type kit hands a custom transport. The sender sends
    // `0n`; kit 6 coerces that to `0`, kit 7+ passes `0n` through, and BOTH
    // serialize to the JSON number 0 on the wire (verified against 6.10.0 and
    // 8.2.0 with a loopback server). `toBe(0)` pinned kit 6's coercion rather
    // than our behaviour, which is what broke the peer matrix in #20.
    const maxRetries = ep.lastSendParams?.maxRetries;
    expect(maxRetries).toBeDefined();
    expect(Number(maxRetries)).toBe(0);
  });

  it("returns expired for a dropped tx and stops at the deadline", async () => {
    const { cluster, rpc, sleep } = setup();
    cluster.scheduleLanding("SigSend3", -1); // silent drop
    const sender = new TransactionSender(rpc, { sleep });
    const res = await sender.sendAndConfirm({
      wireTransaction: "SigSend3",
      signature: "SigSend3",
      lastValidBlockHeight: 710n,
    });
    expect(res.outcome).toBe("expired");
  });

  it("never changes the signature (no re-sign / no double-charge)", async () => {
    const { rpc, sleep } = setup();
    const sender = new TransactionSender(rpc, { sleep });
    const res = await sender.sendAndConfirm({
      wireTransaction: "SigSend4",
      signature: "SigSend4",
      lastValidBlockHeight: 800n,
    });
    expect(res.signature).toBe("SigSend4");
  });

  it("does not abort confirmation when a rebroadcast resend errors (already-processed)", async () => {
    // Once a tx lands, an RPC rejects a resend of the same bytes with a preflight
    // failure ("already processed"). That MUST NOT turn an already-landed tx into
    // a reported failure: the outcome is decided by confirmation status, not by a
    // resend error. A minimal fake RPC reproduces the resend-throws behaviour the
    // mock harness doesn't model.
    const call = <T,>(v: T) => ({ send: async () => v });
    let sends = 0;
    let polls = 0;
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          sends++;
          if (sends > 1) throw new Error("Transaction simulation failed: This transaction has already been processed");
          return "ok";
        },
      }),
      getSignatureStatuses: () =>
        call({ value: [++polls >= 3 ? { err: null, confirmationStatus: "confirmed", slot: 123n } : null] }),
      getBlockHeight: () => call(700n),
    } as unknown as Rpc<SolanaRpcApi>;

    const sender = new TransactionSender(rpc, { sleep: async () => {} });
    const res = await sender.sendAndConfirm({
      wireTransaction: "WIRE",
      signature: "SIG",
      lastValidBlockHeight: 800n,
    });
    expect(res.outcome).toBe("confirmed");
    expect(res.rebroadcasts).toBeGreaterThanOrEqual(1);
    expect(sends).toBeGreaterThan(1); // at least one resend threw and was tolerated
  });

  it("emits landing metrics", async () => {
    const { rpc, sleep } = setup();
    const metrics = new InMemoryMetrics();
    const sender = new TransactionSender(rpc, { sleep, metrics });
    await sender.sendAndConfirm({
      wireTransaction: "SigSend5",
      signature: "SigSend5",
      lastValidBlockHeight: 800n,
    });
    expect(metrics.landings.at(-1)?.outcome).toBe("confirmed");
  });
});
