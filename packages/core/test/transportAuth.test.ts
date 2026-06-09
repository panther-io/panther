import { describe, expect, it } from "vitest";
import { MissingHttpTransportCredentialError, resolveHttpTransportHeaders } from "../src/transportAuth.js";

describe("resolveHttpTransportHeaders", () => {
  it("merges static headers, bearer tokens, API keys, and resolved headers", async () => {
    await expect(
      resolveHttpTransportHeaders(
        {
          headers: { "x-static": "static" },
          bearerToken: "token",
          apiKey: { header: "x-api-key", value: "api-key" },
          resolveHeaders: ({ user }) => ({ "x-user": user.id ?? "none" }),
        },
        { id: "alice" },
      ),
    ).resolves.toEqual({
      "x-static": "static",
      authorization: "Bearer token",
      "x-api-key": "api-key",
      "x-user": "alice",
    });
  });

  it("resolves bearer tokens and API keys from user secrets or tokens", async () => {
    await expect(
      resolveHttpTransportHeaders(
        {
          bearerToken: ({ user }) => user.tokens?.github,
          apiKey: { header: "x-team-key", resolve: ({ user }) => user.secrets?.teamKey },
        },
        { tokens: { github: "oauth-token" }, secrets: { teamKey: "secret-key" } },
      ),
    ).resolves.toEqual({
      authorization: "Bearer oauth-token",
      "x-team-key": "secret-key",
    });
  });

  it("throws a mapped credential error when required resolver credentials are missing", async () => {
    await expect(
      resolveHttpTransportHeaders(
        {
          apiKey: { header: "x-api-key", resolve: ({ user }) => user.secrets?.apiKey },
        },
        { id: "alice", secrets: {} },
      ),
    ).rejects.toBeInstanceOf(MissingHttpTransportCredentialError);
  });

  it("allows optional missing API keys", async () => {
    await expect(
      resolveHttpTransportHeaders({
        apiKey: { header: "x-api-key", resolve: () => undefined, required: false },
      }),
    ).resolves.toEqual({});
  });
});
