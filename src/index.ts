/**
 * solana-resilience-kit — vendor-neutral, client-side resilience + observability
 * layer for Solana dApps, built on @solana/kit (web3.js v2).
 *
 * Public API surface. Implementations are filled in during the build phase;
 * the test suite under /test encodes the required behavior of every export.
 */

// Errors
export * from "./errors.js";
export { ErrorTranslator, TranslatedError, ERROR_PATTERNS } from "./error-translator.js";
export type { ErrorCode, ErrorCategory, TranslateContext } from "./error-translator.js";

// RPC layer
export { ResilientRpcPool } from "./rpc/pool.js";
export type { ResilientEndpoint, ResilientRpcConfig } from "./rpc/pool.js";
// Stable public path for the transport type used in `ResilientEndpoint`, so
// consumers never import from `@solana/rpc-spec` (unresolvable under pnpm's
// strict node-linker; issue #8).
export type { RpcTransport } from "@solana/kit";
export { HealthMonitor } from "./rpc/health.js";
export type { EndpointHealth, HealthMonitorConfig } from "./rpc/health.js";
export { CreditRateLimiter, DEFAULT_METHOD_WEIGHTS } from "./rpc/rate-limit.js";
export type { RateLimiterConfig } from "./rpc/rate-limit.js";
export { ClusterDetector, CLUSTER_GENESIS_HASHES } from "./rpc/cluster.js";
export type { Cluster, ClusterInfo, ClusterGuardConfig, ClusterGuardMode } from "./rpc/cluster.js";

// Transactions
export { TransactionSender } from "./tx/sender.js";
export type { SendConfig, SendResult, SenderDeps } from "./tx/sender.js";
export { ConfirmationTracker } from "./tx/confirmation.js";
export type {
  TrackConfig,
  TrackResult,
  TerminalOutcome,
  ConfirmationDeps,
  SignatureSubscriptionsApi,
  ConfirmationEndpoint,
  MultiEndpointConfig,
} from "./tx/confirmation.js";

// Fees
export { FeeEstimator } from "./fees/estimator.js";
export type { ComputeBudget, EstimateConfig } from "./fees/estimator.js";
export { NativeFeeOracle, HeliusFeeOracle } from "./fees/oracles.js";
export type { FeeOracle, FeeLevel, PriorityFeeEstimate, HttpFeeOracleConfig } from "./fees/oracles.js";

// Jito / MEV
export { JitoRouter } from "./jito/router.js";
export type { JitoEngineClient, JitoRouteConfig, JitoRouteResult } from "./jito/router.js";
export { TipEstimator, MIN_TIP_LAMPORTS } from "./jito/tips.js";
export type { TipFloor, TipPercentile, TipEstimatorConfig } from "./jito/tips.js";

// Observability
export { InMemoryMetrics, OtelMetrics } from "./observability/metrics.js";
export type { Metrics, OtelMetricsConfig } from "./observability/metrics.js";

// Lifecycle events (typed, browser-safe stream for dApp UIs)
export { TypedEventEmitter, LifecycleEmitter } from "./events.js";
export type { LifecycleEventMap, TransactionEvent, EventListener } from "./events.js";

// Wallet
export { ResilientWalletAdapter } from "./wallet/adapter.js";
export type { WalletSigner, ResilientWalletConfig } from "./wallet/adapter.js";
export { WalletAdapterBridge } from "./wallet/wallet-adapter-bridge.js";
export type {
  WalletAdapterSigner,
  WalletAdapterBridgeConfig,
  BridgeSendOptions,
  EncodedTransaction,
  TransactionEncoder,
} from "./wallet/wallet-adapter-bridge.js";

// Diagnostics
export { Diagnostics } from "./cli/diagnose.js";
export type {
  ProbeTarget,
  EndpointProbe,
  ProbeReport,
  TxDiagnosis,
  DiagnosticsDeps,
} from "./cli/diagnose.js";
