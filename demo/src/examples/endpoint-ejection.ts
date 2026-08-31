/**
 * Endpoint ejection — the incident this library exists for: a provider's quota
 * runs out and it answers 429 to everything. A naive pool re-attempts it on
 * every single request forever, paying a wasted round-trip each time while the
 * provider keeps seeing traffic it is already rejecting.
 *
 * The pool ejects it instead: after `failureThreshold` consecutive failures the
 * circuit opens and the endpoint is skipped with NO network call at all. A 429
 * earns a longer cooldown than an ordinary error — that is the provider telling
 * you the budget is gone. Skips are never recorded in the Metrics sink, so an
 * endpoint the pool chose not to contact cannot drag your success rate down.
 */
import { ResilientRpcPool, HealthMonitor, InMemoryMetrics } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialSlot: 280_000_000n });
  const exhausted = new MockEndpoint(cluster, { name: "rpc-exhausted", faults: { rate429Rate: 1 } });
  const secondary = new MockEndpoint(cluster, { name: "rpc-secondary" });

  // A controllable clock so the cooldown is observable without waiting 5 minutes.
  let clock = 0;
  const now = () => clock;

  const metrics = new InMemoryMetrics();
  const pool = new ResilientRpcPool({
    endpoints: [
      { name: exhausted.name, transport: exhausted.transport },
      { name: secondary.name, transport: secondary.transport },
    ],
    freshnessAware: false,
    metrics,
    now,
    healthMonitor: new HealthMonitor({
      endpointNames: [exhausted.name, secondary.name],
      failureThreshold: 3, // three strikes...
      ejectionMs: 30_000, // ...30s out of rotation for an ordinary error...
      rateLimitEjectionMs: 300_000, // ...5 minutes for a 429.
      now,
    }),
  });

  const REQUESTS = 40;
  log(`${REQUESTS} reads while the primary 429s everything…`);
  for (let i = 0; i < REQUESTS; i++) {
    clock += 100;
    await pool.rpc().getSlot().send();
  }

  const ejected = pool.health().find((h) => h.name === exhausted.name);
  const contacted = exhausted.stats.requests; // snapshot before the recovery probe below
  log(`primary contacted ${contacted}x, then the circuit opened`);
  log(`the remaining ${REQUESTS - contacted} requests skipped it at zero network cost`);

  // The provider's quota resets and the cooldown expires: one cheap half-open
  // getSlot probe is spent to find out, and the endpoint returns to rotation.
  exhausted.faults = {};
  clock += 300_001;
  await pool.rpc().getSlot().send();
  const recovered = pool.health().find((h) => h.name === exhausted.name);
  log(`after the 5-minute 429 cooldown: healthy=${recovered?.healthy}, back in rotation`);

  return {
    logs,
    result: {
      requests: REQUESTS,
      "calls to the dead provider": contacted,
      "calls saved": REQUESTS - contacted,
      "429s counted": metrics.rateLimited.length,
      // Skips are absent from the sink, so this reflects real calls only.
      "reported success rate": `${Math.round(metrics.successRate() * 100)}%`,
      "ejected during the outage": Boolean(ejected?.ejected),
      "recovered after cooldown": Boolean(recovered?.healthy),
    },
  };
}
