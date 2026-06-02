import type { Registry, UserContext } from "./types.js";

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
