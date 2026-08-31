/**
 * SPEC (red until implemented): HealthMonitor gains an explicit EJECTION
 * WINDOW (issue #17). Knowing an endpoint is unhealthy is not enough — a
 * quota-constrained deployment needs the pool to stop *calling* it. An
 * endpoint that trips `failureThreshold` is ejected for a cooldown, is not
 * admitted during it, then gets exactly one half-open attempt.
 *
 * A 429 is the provider telling you the budget is gone, so it earns a longer
 * cooldown than an ordinary error — unless the provider sent its own
 * `Retry-After`, which is more authoritative than any guess we make.
 */
import { describe, it, expect } from "vitest";
import { HealthMonitor } from "../../src/rpc/health.js";
import { HttpTransportError } from "../harness/faults.js";

/** A controllable clock so cooldowns are exercised without wall-clock waits. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe("HealthMonitor ejection window (issue #17)", () => {
  it("admits a healthy endpoint", () => {
    const hm = new HealthMonitor({ endpointNames: ["a"] });
    expect(hm.tryAdmit("a")).toBe(true);
    expect(hm.isEjected("a")).toBe(false);
  });

  it("never admits an endpoint it does not know", () => {
    const hm = new HealthMonitor({ endpointNames: ["a"] });
    expect(hm.tryAdmit("ghost")).toBe(false);
  });

  it("does not eject before the failure threshold is reached", () => {
    const hm = new HealthMonitor({ endpointNames: ["a"], failureThreshold: 3 });
    hm.recordFailure("a", new Error("x"));
    hm.recordFailure("a", new Error("x"));
    expect(hm.isEjected("a")).toBe(false);
    expect(hm.tryAdmit("a")).toBe(true);
  });

  it("ejects for ejectionMs once the threshold trips, then half-opens once", () => {
    const c = clock();
    const hm = new HealthMonitor({
      endpointNames: ["a"],
      failureThreshold: 1,
      ejectionMs: 30_000,
      now: c.now,
    });

    hm.recordFailure("a", new Error("boom"));
    expect(hm.isEjected("a")).toBe(true);
    expect(hm.tryAdmit("a")).toBe(false);

    c.advance(29_999);
    expect(hm.tryAdmit("a")).toBe(false);

    c.advance(1);
    // The window has expired: exactly ONE probe is admitted...
    expect(hm.tryAdmit("a")).toBe(true);
    // ...and a concurrent caller still waits, so half-open means half-open.
    expect(hm.tryAdmit("a")).toBe(false);
  });

  it("clears the ejection on a success (closed circuit)", () => {
    const c = clock();
    const hm = new HealthMonitor({ endpointNames: ["a"], failureThreshold: 1, ejectionMs: 30_000, now: c.now });
    hm.recordFailure("a", new Error("boom"));
    expect(hm.isEjected("a")).toBe(true);

    hm.recordSuccess("a", 10, 100n);
    expect(hm.isEjected("a")).toBe(false);
    expect(hm.tryAdmit("a")).toBe(true);
    expect(hm.isHealthy("a")).toBe(true);
  });

  it("re-ejects when the half-open attempt fails again", () => {
    const c = clock();
    const hm = new HealthMonitor({ endpointNames: ["a"], failureThreshold: 1, ejectionMs: 10_000, now: c.now });
    hm.recordFailure("a", new Error("boom"));
    c.advance(10_000);
    expect(hm.tryAdmit("a")).toBe(true);

    hm.recordFailure("a", new Error("still down"));
    c.advance(9_999);
    expect(hm.tryAdmit("a")).toBe(false);
    c.advance(1);
    expect(hm.tryAdmit("a")).toBe(true);
  });

  it("gives a 429 the longer rate-limit cooldown", () => {
    const c = clock();
    const hm = new HealthMonitor({
      endpointNames: ["a"],
      failureThreshold: 1,
      ejectionMs: 30_000,
      rateLimitEjectionMs: 300_000,
      now: c.now,
    });
    hm.recordFailure("a", new HttpTransportError(429, "slow down"));

    c.advance(30_000); // an ordinary error would be back by now
    expect(hm.tryAdmit("a")).toBe(false);
    c.advance(270_000);
    expect(hm.tryAdmit("a")).toBe(true);
  });

  it("prefers the provider's own Retry-After over the guessed cooldown", () => {
    const c = clock();
    const hm = new HealthMonitor({
      endpointNames: ["a"],
      failureThreshold: 1,
      ejectionMs: 1_000,
      rateLimitEjectionMs: 300_000,
      now: c.now,
    });
    const err = Object.assign(new Error("429"), {
      statusCode: 429,
      headers: { "retry-after": "5" },
    });
    hm.recordFailure("a", err);

    c.advance(4_999);
    expect(hm.tryAdmit("a")).toBe(false);
    c.advance(1); // 5s, as the provider asked — not the 5-minute default
    expect(hm.tryAdmit("a")).toBe(true);
  });

  it("treats ejectionMs: 0 as 'never eject' (opt out of the breaker)", () => {
    const hm = new HealthMonitor({ endpointNames: ["a"], failureThreshold: 1, ejectionMs: 0 });
    hm.recordFailure("a", new HttpTransportError(429));
    hm.recordFailure("a", new Error("x"));
    expect(hm.isEjected("a")).toBe(false);
    expect(hm.tryAdmit("a")).toBe(true);
    expect(hm.isHealthy("a")).toBe(false); // still reported unhealthy, just not ejected
  });

  it("surfaces the ejection in the snapshot", () => {
    const c = clock(1_000);
    const hm = new HealthMonitor({ endpointNames: ["a"], failureThreshold: 1, ejectionMs: 30_000, now: c.now });
    hm.recordFailure("a", new Error("boom"));
    const snap = hm.snapshot().find((s) => s.name === "a");
    expect(snap?.ejected).toBe(true);
    expect(snap?.ejectedUntil).toBe(31_000);
  });
});
