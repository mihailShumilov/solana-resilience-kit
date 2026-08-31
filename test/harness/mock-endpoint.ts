/**
 * MockEndpoint — wraps a shared MockCluster with a per-endpoint fault profile
 * and exposes a `@solana/kit`-compatible `RpcTransport`. Multiple endpoints can
 * share one cluster (one ledger truth) while each presents its own health:
 * latency, drops, 429s, and slot lag. This is what lets us simulate an
 * "unhealthy RPC pool" — e.g. one advanced node and one lagging node.
 */
// Type-identical to @solana/rpc-spec's RpcTransport (kit re-exports it), but
// this file ships as the `./testing` subpath, so its d.ts must only reference
// the peer `@solana/kit` (issue #8).
import type { RpcTransport } from "@solana/kit";
import { MockCluster } from "./mock-cluster.js";
import { type EndpointFaultProfile, HttpTransportError, TransportDroppedError } from "./faults.js";
import { type Rng, makeRng, chance, randInt } from "./rng.js";

interface JsonRpcPayload {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown[];
}

export interface MockEndpointOptions {
  name?: string;
  faults?: EndpointFaultProfile;
  rngSeed?: number;
}

export class MockEndpoint {
  readonly name: string;
  faults: EndpointFaultProfile;
  private readonly rng: Rng;
  /** Counters tests/observability can assert against. */
  readonly stats = { requests: 0, errors: 0, rateLimited: 0, dropped: 0, sends: 0, errorBodies: 0 };
  /** Per-method invocation counts (e.g. how many getSignatureStatuses polls ran). */
  readonly rpcCalls: Record<string, number> = {};
  /** The config object (params[1]) of the most recent sendTransaction call. */
  lastSendParams: Record<string, unknown> | undefined;

  constructor(
    private readonly cluster: MockCluster,
    opts: MockEndpointOptions = {},
  ) {
    this.name = opts.name ?? "endpoint";
    this.faults = opts.faults ?? {};
    this.rng = makeRng(opts.rngSeed ?? 0xc0ffee);
  }

  private async applyLatency(signal?: AbortSignal): Promise<void> {
    const l = this.faults.latencyMs;
    if (l === undefined) return;
    const ms = Array.isArray(l) ? randInt(this.rng, l[0], l[1]) : l;
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new TransportDroppedError("aborted"));
      });
    });
  }

  private adjustForLag<T>(method: string, result: T): T {
    const lag = BigInt(this.faults.slotLag ?? 0);
    if (lag === 0n) return result;
    if (method === "getSlot" || method === "getBlockHeight") {
      return ((result as bigint) - lag) as unknown as T;
    }
    if (method === "getLatestBlockhash") {
      const r = result as { context: { slot: bigint }; value: { blockhash: string; lastValidBlockHeight: bigint } };
      return {
        context: { slot: r.context.slot - lag },
        value: { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight - lag },
      } as unknown as T;
    }
    return result;
  }

  /** The kit-compatible transport. Returns the full JSON-RPC response object. */
  get transport(): RpcTransport {
    const self = this;
    return async function transport<TResponse>(config: {
      payload: unknown;
      signal?: AbortSignal;
    }): Promise<TResponse> {
      self.stats.requests += 1;
      const payload = config.payload as JsonRpcPayload;

      if (self.faults.offline) {
        self.stats.errors += 1;
        throw new TransportDroppedError(`${self.name} offline`);
      }
      if (chance(self.rng, self.faults.rate429Rate ?? 0)) {
        self.stats.rateLimited += 1;
        self.stats.errors += 1;
        throw new HttpTransportError(429, `${self.name} rate limited`);
      }
      if (chance(self.rng, self.faults.errorRate ?? 0)) {
        self.stats.errors += 1;
        throw new HttpTransportError(503, `${self.name} unavailable`);
      }

      await self.applyLatency(config.signal);

      // An error BODY over a successful HTTP response. Returned, never thrown —
      // that asymmetry is exactly what made this failure class invisible.
      const bodyError = self.faults.jsonRpcError;
      if (bodyError !== undefined) {
        self.stats.errorBodies += 1;
        return {
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: bodyError.code, message: bodyError.message ?? "" },
        } as unknown as TResponse;
      }

      const result = self.dispatch(payload);
      return { jsonrpc: "2.0", id: payload.id, result } as unknown as TResponse;
    };
  }

  private dispatch(payload: JsonRpcPayload): unknown {
    const params = payload.params ?? [];
    this.rpcCalls[payload.method] = (this.rpcCalls[payload.method] ?? 0) + 1;
    switch (payload.method) {
      case "getSlot":
        return this.adjustForLag("getSlot", this.cluster.rpcGetSlot());
      case "getBlockHeight":
        return this.adjustForLag("getBlockHeight", this.cluster.rpcGetBlockHeight());
      case "getGenesisHash":
        return this.cluster.rpcGetGenesisHash();
      case "getLatestBlockhash":
        return this.adjustForLag("getLatestBlockhash", this.cluster.rpcGetLatestBlockhash());
      case "sendTransaction": {
        this.stats.sends += 1;
        this.lastSendParams = params[1] as Record<string, unknown> | undefined;
        const dropped = chance(this.rng, this.faults.dropRate ?? 0);
        if (dropped) this.stats.dropped += 1;
        return this.cluster.rpcSendTransaction(params[0] as string, { dropped });
      }
      case "getSignatureStatuses":
        return this.cluster.rpcGetSignatureStatuses((params[0] as string[]) ?? []);
      case "simulateTransaction":
        return this.cluster.rpcSimulateTransaction();
      case "getRecentPrioritizationFees":
        return this.cluster.rpcGetRecentPrioritizationFees();
      default:
        throw new HttpTransportError(404, `unhandled method ${payload.method}`);
    }
  }
}
