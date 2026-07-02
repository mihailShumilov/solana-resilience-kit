/**
 * Typed lifecycle event stream for dApp UIs (issue #3).
 *
 * A dependency-free, browser-safe event emitter (NO Node `events` import) with a
 * strict event map: subscribing to a key infers the exact payload type, and a
 * wrong key or payload is a compile error. The SDK emits the same internal
 * signals here (for UIs) that it reports to OpenTelemetry (for infra), so a
 * frontend can render live "pending → sent → confirmed/failed/expired" and
 * connection state without re-deriving it.
 *
 * Delivery is best-effort: a throwing listener is isolated so a buggy UI handler
 * can never break the send/route path.
 */

// Type-only: which side of the WS-vs-poll race delivered a terminal outcome.
// Optional on the payloads so hand-written emitters stay source-compatible;
// the SDK's own sender always populates it (issue #10).
import type { ConfirmationPath } from "./tx/confirmation.js";

/** Fields common to every `transaction:*` event. `txId` is stable per send. */
export interface TransactionEvent {
  /** Stable identifier for this logical send, consistent across its events. */
  txId: string;
  /** The transaction signature being tracked. */
  signature: string;
  /** Attempt/rebroadcast count at the moment of the event (0 = initial). */
  attempt: number;
  /** Milliseconds elapsed since the send began. */
  durationMs: number;
}

/** The strict event-key → payload map. */
export type LifecycleEventMap = {
  "transaction:pending": TransactionEvent;
  "transaction:simulated": TransactionEvent;
  "transaction:sent": TransactionEvent;
  "transaction:confirmed": TransactionEvent & { slot: bigint | null; via?: ConfirmationPath };
  "transaction:failed": TransactionEvent & { err: unknown; via?: ConfirmationPath };
  "transaction:expired": TransactionEvent;
  /**
   * The signature subscription errored or closed without delivering, and the
   * tracker fell back to pure polling. NOT emitted when WS merely loses the
   * race to a faster poll, and never in pure-polling mode.
   */
  "transaction:ws-fallback": { signature: string; reason: string };
  "connection:failover": { from: string; to: string; reason: string };
  "connection:health": { endpoint: string; healthy: boolean; slot: bigint | null };
  "connection:cluster-detected": { cluster: string; genesisHash: string };
  "connection:cluster-mismatch": { expected: string; actual: string; genesisHash: string };
};

export type EventListener<T> = (payload: T) => void;

/**
 * A minimal generic typed emitter. Listener storage is a mapped type, so every
 * `on`/`once`/`off`/`emit` is fully type-checked against `EventMap` with no
 * `any` and no runtime dependency.
 */
export class TypedEventEmitter<EventMap> {
  private readonly listeners: { [K in keyof EventMap]?: Set<EventListener<EventMap[K]>> } = {};

  /** Subscribe. Returns an unsubscribe function for convenience. */
  on<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): () => void {
    const set = (this.listeners[event] ??= new Set<EventListener<EventMap[K]>>());
    set.add(listener);
    return () => {
      this.off(event, listener);
    };
  }

  /** Subscribe once; the listener auto-removes after its first invocation. */
  once<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): () => void {
    const wrapper: EventListener<EventMap[K]> = (payload) => {
      this.off(event, wrapper);
      listener(payload);
    };
    return this.on(event, wrapper);
  }

  /** Unsubscribe a specific listener. A no-op if it was never registered. */
  off<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): void {
    this.listeners[event]?.delete(listener);
  }

  /** Emit an event. No listeners is a no-op; a throwing listener is isolated. */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners[event];
    if (set === undefined) return;
    // Snapshot so once()/off() mutations during dispatch are safe.
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch {
        // Best-effort UI delivery: a buggy listener must not break the caller.
      }
    }
  }

  /** Remove all listeners for one event, or for every event when omitted. */
  removeAllListeners<K extends keyof EventMap>(event?: K): void {
    if (event === undefined) {
      for (const key of Object.keys(this.listeners) as Array<keyof EventMap>) {
        delete this.listeners[key];
      }
      return;
    }
    delete this.listeners[event];
  }
}

/** The SDK's concrete lifecycle emitter over {@link LifecycleEventMap}. */
export class LifecycleEmitter extends TypedEventEmitter<LifecycleEventMap> {}
