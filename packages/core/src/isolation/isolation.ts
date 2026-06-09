import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Isolation } from "../types/policy.js";
import type { MaybePromise } from "../types/shared.js";

type QueueState = {
  active: number;
  queue: Array<() => void>;
};

/**
 * In-process per-user isolation runtime.
 * @pk
 */
export class InProcessIsolation implements Isolation {
  private readonly queues = new Map<string, QueueState>();
  private readonly maxConcurrency: number;
  private closed = false;

  /**
   * Create an in-process isolation runtime.
   * @pk
   */
  constructor(options: { maxConcurrency?: number } = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 1;
    if (this.maxConcurrency < 1) {
      throw new Error("Isolation maxConcurrency must be at least 1");
    }
  }

  async queue(
    userId: string,
    fn: () => MaybePromise<CallToolResult>,
    timeout?: number,
  ): Promise<CallToolResult> {
    if (this.closed) {
      throw new Error("Isolation runtime is closed");
    }

    await this.acquire(userId);
    try {
      return await withTimeout(fn, timeout);
    } finally {
      this.release(userId);
    }
  }

  close(): void {
    this.closed = true;
    this.queues.clear();
  }

  private acquire(userId: string): Promise<void> {
    const state = this.stateFor(userId);
    if (state.active < this.maxConcurrency) {
      state.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      state.queue.push(() => {
        state.active += 1;
        resolve();
      });
    });
  }

  private release(userId: string): void {
    const state = this.queues.get(userId);
    if (!state) {
      return;
    }

    state.active -= 1;
    const next = state.queue.shift();
    if (next) {
      next();
      return;
    }

    if (state.active === 0) {
      this.queues.delete(userId);
    }
  }

  private stateFor(userId: string): QueueState {
    const existing = this.queues.get(userId);
    if (existing) {
      return existing;
    }

    const state = { active: 0, queue: [] };
    this.queues.set(userId, state);
    return state;
  }
}

async function withTimeout(
  fn: () => MaybePromise<CallToolResult>,
  timeout: number | undefined,
): Promise<CallToolResult> {
  if (!timeout) {
    return fn();
  }

  return Promise.race([
    Promise.resolve(fn()),
    new Promise<CallToolResult>((_, reject) => {
      setTimeout(() => reject(new Error(`Isolated tool call timed out after ${timeout}ms`)), timeout);
    }),
  ]);
}
