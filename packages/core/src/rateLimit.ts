import type { RateLimitStore } from "./types.js";

type Bucket = {
  count: number;
  expiresAt: number;
};

/**
 * In-memory rate limit store with expiring buckets.
 * @pk
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  async increment(key: string, window: number): Promise<number> {
    const now = Date.now();
    const bucket = this.activeBucket(key, now);
    if (!bucket) {
      this.buckets.set(key, { count: 1, expiresAt: now + window });
      return 1;
    }

    bucket.count += 1;
    return bucket.count;
  }

  async get(key: string): Promise<number> {
    return this.activeBucket(key, Date.now())?.count ?? 0;
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  private activeBucket(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return undefined;
    }

    if (bucket.expiresAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }

    return bucket;
  }
}
