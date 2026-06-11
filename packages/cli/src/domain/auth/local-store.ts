import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FentarisAuth, type LocalCredentials } from "@fentaris/core";
import type { CliOptions, Runtime } from "../../shared/types.js";
import { redactRecord, required } from "../../shared/utils.js";

export async function initLocalAuth(options: CliOptions): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  await mkdir(dir, { recursive: true });
  await writeCredentials(dir, key, { users: {}, groups: {}, defaults: {} });
  await writeFile(path.join(dir, "upstream-auth.json"), JSON.stringify({ servers: {} }, null, 2));
}

export async function storeCredential(dir: string, key: string, reference: string, value: string, options: CliOptions): Promise<void> {
  const credentials = await readCredentials(dir, key);

  if (typeof options.user === "string") {
    const user = credentials.users[options.user] ?? { apiKeys: [], credentials: {} };
    credentials.users[options.user] = { ...user, credentials: { ...user.credentials, [reference]: value } };
  } else if (typeof options.group === "string") {
    credentials.groups[options.group] = { ...(credentials.groups[options.group] ?? {}), [reference]: value };
  } else {
    credentials.defaults[reference] = value;
  }

  await writeCredentials(dir, key, credentials);
}

export async function addUserApiKey(dir: string, key: string, userId: string, apiKey: string): Promise<void> {
  const credentials = await readCredentials(dir, key);
  const user = credentials.users[userId] ?? { apiKeys: [], credentials: {} };
  const hashed = FentarisAuth.hashApiKey(apiKey);
  credentials.users[userId] = {
    ...user,
    apiKeys: user.apiKeys.includes(hashed) ? user.apiKeys : [...user.apiKeys, hashed],
  };
  await writeCredentials(dir, key, credentials);
}

export async function inspectAuthFiles(dir: string, key: string): Promise<unknown> {
  const credentials = await readCredentials(dir, key);
  const upstreamAuth = JSON.parse(await readFile(path.join(dir, "upstream-auth.json"), "utf8")) as unknown;

  return {
    credentials: {
      users: Object.fromEntries(
        Object.entries(credentials.users).map(([userId, userEntry]) => [
          userId,
          {
            apiKeys: userEntry.apiKeys.map(() => "<redacted>"),
            credentials: redactRecord(userEntry.credentials),
          },
        ]),
      ),
      groups: Object.fromEntries(Object.entries(credentials.groups).map(([groupId, values]) => [groupId, redactRecord(values)])),
      defaults: redactRecord(credentials.defaults),
    },
    upstreamAuth,
  };
}

export async function authKeyFromRuntime(runtime: Runtime, options: CliOptions): Promise<string> {
  if (typeof options.key === "string") {
    return options.key;
  }
  if (typeof runtime.env.FENTARIS_AUTH_KEY === "string" && runtime.env.FENTARIS_AUTH_KEY.trim()) {
    return runtime.env.FENTARIS_AUTH_KEY;
  }
  return runtime.prompt.text("Local auth encryption key", { secret: true });
}

export function secretScope(options: CliOptions): string {
  if (typeof options.user === "string") {
    return `user ${options.user}`;
  }
  if (typeof options.group === "string") {
    return `group ${options.group}`;
  }
  return "default";
}

export async function readCredentials(dir: string, key: string): Promise<LocalCredentials> {
  return FentarisAuth.decryptCredentials(JSON.parse(await readFile(path.join(dir, "credentials.enc.json"), "utf8")) as unknown, key);
}

export async function writeCredentials(dir: string, key: string, credentials: LocalCredentials): Promise<void> {
  await writeFile(path.join(dir, "credentials.enc.json"), JSON.stringify(FentarisAuth.encryptCredentials(credentials, key), null, 2));
}
