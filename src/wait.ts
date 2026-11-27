import { type Delivery, ENDED_STATUSES, type OpenBotApi, type Pending, pendingCount } from "./api.js";
import { OpenBotError } from "./connection.js";

export type WaitState = "ended" | "needs-person" | "timed-out" | "cancelled";

export interface WaitResult {
  state: WaitState;
  delivery: Delivery | null;
  /** Set when state is "needs-person": what the agent waits for. */
  pending?: Pending;
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called after each poll with the latest status (used for MCP progress notifications). */
  onPoll?: (delivery: Delivery, elapsedMs: number) => void | Promise<void>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * Polls one delivery until it ends, a person must answer something, the time is up,
 * or the MCP client cancels. Timing out or cancelling stops only the wait — the agent keeps working.
 */
export async function waitForDelivery(
  api: OpenBotApi,
  agentId: string,
  deliveryId: string,
  { timeoutMs, pollMs = 2000, signal, onPoll }: WaitOptions,
): Promise<WaitResult> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last: Delivery | null = null;
  for (;;) {
    if (signal?.aborted) return { state: "cancelled", delivery: last };
    try {
      last = await api.getDelivery(agentId, deliveryId);
      await onPoll?.(last, Date.now() - started);
      if (ENDED_STATUSES.has(last.status)) return { state: "ended", delivery: last };
      // A question/approval/browser takeover blocks the turn; returning lets the caller answer it.
      // (Same rule as openbot-cli's exit code 3.)
      if (last.status === "running" || last.status === "queued" || last.status === "starting") {
        const pending = await api.getPending(agentId);
        if (pendingCount(pending) > 0) return { state: "needs-person", delivery: last, pending };
      }
    } catch (error) {
      // OpenBot restarting mid-wait: keep trying until the deadline (the connection re-reads the files).
      if (!(error instanceof OpenBotError) || !error.stale || Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) return { state: "timed-out", delivery: last };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
}
