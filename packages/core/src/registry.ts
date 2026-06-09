import type { Registry } from "./types/policy.js";
import type { UserContext } from "./types/shared.js";

/**
 * Minimal Redis-compatible client contract.
 * @pk
 */
export type RedisRegistryClient = {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<unknown> | unknown;
};

/**
 * Options for Redis-backed registry storage.
 * @pk
 */
export type RedisRegistryOptions = {
  client: RedisRegistryClient;
  keyPrefix?: string;
};

/**
 * Development registry backed by in-memory maps.
 * @pk
 */
export class MemoryRegistry implements Registry {
  private readonly users = new Map<string, UserContext>();
  private readonly secrets = new Map<string, Record<string, string>>();
  private readonly tokens = new Map<string, Record<string, string>>();

  /**
   * Create an in-memory registry.
   * @pk
   */
  constructor(options: {
    users?: Record<string, UserContext>;
    secrets?: Record<string, Record<string, string>>;
    tokens?: Record<string, Record<string, string>>;
  } = {}) {
    for (const [userId, user] of Object.entries(options.users ?? {})) {
      this.setUser(userId, user);
    }

    for (const [userId, userSecrets] of Object.entries(options.secrets ?? {})) {
      this.setSecrets(userId, userSecrets);
    }

    for (const [userId, userTokens] of Object.entries(options.tokens ?? {})) {
      this.setTokens(userId, userTokens);
    }
  }

  /**
   * Store or replace a user record.
   * @pk
   */
  setUser(userId: string, user: UserContext): this {
    this.users.set(userId, { ...user, id: user.id ?? userId });
    return this;
  }

  /**
   * Store or replace user secrets.
   * @pk
   */
  setSecrets(userId: string, secrets: Record<string, string>): this {
    this.secrets.set(userId, { ...secrets });
    return this;
  }

  /**
   * Store or replace user tokens.
   * @pk
   */
  setTokens(userId: string, tokens: Record<string, string>): this {
    this.tokens.set(userId, { ...tokens });
    return this;
  }

  async getUser(userId: string): Promise<UserContext | null> {
    return this.clone(this.users.get(userId));
  }

  async getSecrets(userId: string): Promise<Record<string, string> | null> {
    return this.clone(this.secrets.get(userId));
  }

  async getTokens(userId: string): Promise<Record<string, string> | null> {
    return this.clone(this.tokens.get(userId));
  }

  private clone<T extends Record<string, unknown>>(value: T | undefined): T | null {
    return value ? ({ ...value } as T) : null;
  }
}

/**
 * Redis-backed registry using JSON values.
 * @pk
 */
export class RedisRegistry implements Registry {
  private readonly client: RedisRegistryClient;
  private readonly keyPrefix: string;

  /**
   * Create a Redis-backed registry.
   * @pk
   */
  constructor(options: RedisRegistryOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? "fentaris:registry";
  }

  /**
   * Store or replace a user record.
   * @pk
   */
  async setUser(userId: string, user: UserContext): Promise<void> {
    await this.setJson(this.key("users", userId), { ...user, id: user.id ?? userId });
  }

  /**
   * Store or replace user secrets.
   * @pk
   */
  async setSecrets(userId: string, secrets: Record<string, string>): Promise<void> {
    await this.setJson(this.key("secrets", userId), secrets);
  }

  /**
   * Store or replace user tokens.
   * @pk
   */
  async setTokens(userId: string, tokens: Record<string, string>): Promise<void> {
    await this.setJson(this.key("tokens", userId), tokens);
  }

  async getUser(userId: string): Promise<UserContext | null> {
    return this.getJson<UserContext>(this.key("users", userId));
  }

  async getSecrets(userId: string): Promise<Record<string, string> | null> {
    return this.getJson<Record<string, string>>(this.key("secrets", userId));
  }

  async getTokens(userId: string): Promise<Record<string, string> | null> {
    return this.getJson<Record<string, string>>(this.key("tokens", userId));
  }

  private key(kind: "users" | "secrets" | "tokens", userId: string): string {
    return `${this.keyPrefix}:${kind}:${userId}`;
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) {
      return null;
    }

    return JSON.parse(value) as T;
  }

  private async setJson(key: string, value: unknown): Promise<void> {
    await this.client.set(key, JSON.stringify(value));
  }
}
