/**
 * Cookbook registry. Each example is imported TWICE from the same file — as a
 * module (its `run`, executed by the Run button) and as raw text (via `?raw`,
 * shown in the code block). One file, one source of truth: what you read is
 * exactly what runs.
 */
import type { ExampleResult } from "./types.js";

import { run as failoverPool } from "./failover-pool.js";
import failoverPoolSrc from "./failover-pool.ts?raw";
import { run as reliableSend } from "./reliable-send.js";
import reliableSendSrc from "./reliable-send.ts?raw";
import { run as blockhashExpiry } from "./blockhash-expiry.js";
import blockhashExpirySrc from "./blockhash-expiry.ts?raw";
import { run as freshnessRouting } from "./freshness-routing.js";
import freshnessRoutingSrc from "./freshness-routing.ts?raw";
import { run as endpointEjection } from "./endpoint-ejection.js";
import endpointEjectionSrc from "./endpoint-ejection.ts?raw";
import { run as errorBodyFailover } from "./error-body-failover.js";
import errorBodyFailoverSrc from "./error-body-failover.ts?raw";
import { run as jitoFallback } from "./jito-fallback.js";
import jitoFallbackSrc from "./jito-fallback.ts?raw";
import { run as feeEstimation } from "./fee-estimation.js";
import feeEstimationSrc from "./fee-estimation.ts?raw";
import { run as observability } from "./observability.js";
import observabilitySrc from "./observability.ts?raw";
import { run as clusterGuard } from "./cluster-guard.js";
import clusterGuardSrc from "./cluster-guard.ts?raw";
import { run as multiEndpointConfirm } from "./multi-endpoint-confirm.js";
import multiEndpointConfirmSrc from "./multi-endpoint-confirm.ts?raw";
import { run as lifecycleEvents } from "./lifecycle-events.js";
import lifecycleEventsSrc from "./lifecycle-events.ts?raw";
import { run as errorTranslation } from "./error-translation.js";
import errorTranslationSrc from "./error-translation.ts?raw";
import { run as walletBridge } from "./wallet-bridge.js";
import walletBridgeSrc from "./wallet-bridge.ts?raw";
import { run as testYourDapp } from "./test-your-dapp.js";
import testYourDappSrc from "./test-your-dapp.ts?raw";

export interface Example {
  id: string;
  title: string;
  /** Short tag shown in the card header. */
  tag: string;
  description: string;
  /** The example's full source (single source of truth). */
  code: string;
  /** Runs the example against the harness and returns its result. */
  run: () => Promise<ExampleResult>;
}

export const EXAMPLES: Example[] = [
  {
    id: "failover-pool",
    title: "Failover pool",
    tag: "rpc · failover",
    description:
      "One endpoint rate-limits with HTTP 429, the other is healthy. A read fails over to the backup automatically — pool.rpc() is just a normal @solana/kit RPC.",
    code: failoverPoolSrc,
    run: failoverPool,
  },
  {
    id: "reliable-send",
    title: "Reliable send",
    tag: "tx · rebroadcast",
    description:
      "A dropped broadcast returns no error and never lands. The sender uses maxRetries:0 and its own rebroadcast loop — resending the SAME bytes, bounded by lastValidBlockHeight — until it confirms.",
    code: reliableSendSrc,
    run: reliableSend,
  },
  {
    id: "blockhash-expiry",
    title: "Blockhash expiry",
    tag: "tx · termination",
    description:
      "A tx that never lands must terminate, not spin forever. The loop is bounded solely by lastValidBlockHeight: it stops at expiry, returns a clean 'expired', and never re-signs.",
    code: blockhashExpirySrc,
    run: blockhashExpiry,
  },
  {
    id: "freshness-routing",
    title: "Freshness routing",
    tag: "rpc · health",
    description:
      "A lagging RPC answers fine but is hundreds of slots behind — a silent tx killer. The HealthMonitor probes every node's slot and routes around the laggard, even when it's listed first.",
    code: freshnessRoutingSrc,
    run: freshnessRouting,
  },
  {
    id: "endpoint-ejection",
    title: "Endpoint ejection",
    tag: "rpc · circuit breaker",
    description:
      "A provider's quota runs out and it 429s everything. After three strikes the pool opens the circuit and skips it with no network call at all, then half-opens once the cooldown expires. Skips never reach the Metrics sink, so they can't drag your success rate down.",
    code: endpointEjectionSrc,
    run: endpointEjection,
  },
  {
    id: "error-body-failover",
    title: "Error bodies that look like success",
    tag: "rpc · failover",
    description:
      "A node that is behind answers HTTP 200 with a JSON-RPC error body, so transports don't throw and naive pools count it as a success. The pool reads the body, fails over, and ejects the node — while leaving caller faults like 'invalid params' alone.",
    code: errorBodyFailoverSrc,
    run: errorBodyFailover,
  },
  {
    id: "jito-fallback",
    title: "Jito with fallback",
    tag: "jito · mev",
    description:
      "A bundle_id is a receipt, not a landing guarantee. The router polls bundle status a bounded number of times, then falls back to RPC submission with the same signed bytes → confirmed.",
    code: jitoFallbackSrc,
    run: jitoFallback,
  },
  {
    id: "fee-estimation",
    title: "Fee / CU estimation",
    tag: "fees · compute",
    description:
      "Priority fee is charged on the CU limit you request. Simulate for actual compute units, add a +10% margin, and pair it with a percentile fee from a pluggable oracle.",
    code: feeEstimationSrc,
    run: feeEstimation,
  },
  {
    id: "observability",
    title: "Observability",
    tag: "metrics",
    description:
      "One Metrics sink, shared by the pool and sender, captures landing rate, failovers, and rebroadcasts across a batch of sends — with zero extra instrumentation in your code.",
    code: observabilitySrc,
    run: observability,
  },
  {
    id: "cluster-guard",
    title: "Cluster guard",
    tag: "rpc · safety",
    description:
      "Sending a mainnet-intended tx to a devnet RPC is a classic footgun. ClusterDetector reads the immutable genesis hash (cached per client) and the sender's clusterGuard throws ClusterMismatchError BEFORE any broadcast leaves the client.",
    code: clusterGuardSrc,
    run: clusterGuard,
  },
  {
    id: "multi-endpoint-confirm",
    title: "Multi-endpoint + WebSocket confirm",
    tag: "tx · confirmation",
    description:
      "A lagging node can withhold a signature status. ConfirmationTracker fans status polling across the freshest healthy endpoints (any node's definitive result wins, dead nodes tolerated) and races a signatureNotifications WebSocket fast-path — while the poll loop stays the sole authority for expiry. Every outcome reports via: \"ws\" | \"poll\", so the WS latency benefit is measurable.",
    code: multiEndpointConfirmSrc,
    run: multiEndpointConfirm,
  },
  {
    id: "lifecycle-events",
    title: "Lifecycle events",
    tag: "events · UI",
    description:
      "The SDK emits the same internal signals to a typed, browser-safe LifecycleEmitter (for UIs) that it reports to OpenTelemetry (for infra). Subscribe once and render live pending → sent → confirmed (with via: ws | poll path attribution) plus failover, health, and ws-fallback — a throwing listener is isolated from the send path.",
    code: lifecycleEventsSrc,
    run: lifecycleEvents,
  },
  {
    id: "error-translation",
    title: "Error translation",
    tag: "dx · errors",
    description:
      "Raw Solana errors are opaque (RPC strings, program Custom codes as hex, wallet rejections, 429s). ErrorTranslator maps them to a stable code + category + human userMessage + suggestion, preserving the original. Pure, total, idempotent — the same dictionary backs the CLI.",
    code: errorTranslationSrc,
    run: errorTranslation,
  },
  {
    id: "wallet-bridge",
    title: "Wallet-adapter bridge",
    tag: "wallet · dx",
    description:
      "Bring your own wallet-adapter wallet and land its signed transactions through the resilient pipeline (and Jito with fallback). It never re-signs, surfaces a rejection as typed USER_REJECTED, and signAndSendAll batches a sign-once / land-in-order flow.",
    code: walletBridgeSrc,
    run: walletBridge,
  },
  {
    id: "test-your-dapp",
    title: "Test your dApp",
    tag: "testing harness",
    description:
      "The deterministic harness ships under solana-resilience-kit/testing. Script the happy path and the failure paths your code must survive — no network, no flake. Drops straight into Vitest/Jest.",
    code: testYourDappSrc,
    run: testYourDapp,
  },
];
