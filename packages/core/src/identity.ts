import type { IdentityStrategy, UserContext } from "./types.js";

/**
 * Create a strategy that resolves identity from request headers.
 * @pk
 */
export function headerIdentityStrategy(options: {
  userIdHeader?: string;
  metadataHeaders?: Record<string, string>;
  name?: string;
} = {}): IdentityStrategy {
  const userIdHeader = normalizeHeaderName(options.userIdHeader ?? "x-user-id");
  const metadataHeaders = Object.entries(options.metadataHeaders ?? {}).map(([metadataKey, headerName]) => [
    metadataKey,
    normalizeHeaderName(headerName),
  ] as const);

  return {
    name: options.name ?? "header",
    resolve(request): UserContext | null {
      const headers = request.headers ?? {};
      const id = headers[userIdHeader];
      if (!id) {
        return null;
      }

      const metadata: Record<string, string> = {};
      for (const [metadataKey, headerName] of metadataHeaders) {
        const value = headers[headerName];
        if (value) {
          metadata[metadataKey] = value;
        }
      }

      return Object.keys(metadata).length > 0 ? { id, metadata } : { id };
    },
  };
}

/**
 * Create a strategy that resolves identity from bearer tokens.
 * @pk
 */
export function bearerTokenIdentityStrategy(options: {
  resolveToken: (token: string) => UserContext | null | Promise<UserContext | null>;
  authorizationHeader?: string;
  name?: string;
}): IdentityStrategy {
  const authorizationHeader = normalizeHeaderName(options.authorizationHeader ?? "authorization");

  return {
    name: options.name ?? "bearer-token",
    async resolve(request): Promise<UserContext | null> {
      const header = request.headers?.[authorizationHeader];
      if (!header?.toLowerCase().startsWith("bearer ")) {
        return null;
      }

      return options.resolveToken(header.slice("bearer ".length).trim());
    },
  };
}

function normalizeHeaderName(headerName: string): string {
  return headerName.toLowerCase();
}
