#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PantherAuth, type LocalCredentials } from "@panther/core";

type CliOptions = Record<string, string | boolean>;

async function main(argv: string[]): Promise<void> {
  const [area, action, ...rest] = argv;
  const options = parseOptions(rest);

  if (area !== "auth" || !action) {
    printHelp();
    return;
  }

  if (action === "init") {
    await initAuth(options);
  } else if (action === "set-api-key") {
    await setApiKey(options);
  } else if (action === "set-credential") {
    await setCredential(options);
  } else if (action === "inspect") {
    await inspectAuth(options);
  } else {
    printHelp();
  }
}

async function initAuth(options: CliOptions): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  await mkdir(dir, { recursive: true });
  await writeCredentials(dir, key, { users: {}, groups: {}, defaults: {} });
  await writeFile(path.join(dir, "upstream-auth.json"), JSON.stringify({ servers: {} }, null, 2));
  console.log(`Initialized local auth files in ${dir}`);
}

async function setApiKey(options: CliOptions): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  const userId = required(options, "user");
  const apiKey = required(options, "api-key");
  const credentials = await readCredentials(dir, key);
  const user = credentials.users[userId] ?? { apiKeys: [], credentials: {} };
  const hashed = PantherAuth.hashApiKey(apiKey);
  credentials.users[userId] = {
    ...user,
    apiKeys: user.apiKeys.includes(hashed) ? user.apiKeys : [...user.apiKeys, hashed],
  };
  await writeCredentials(dir, key, credentials);
  console.log(`Stored API key hash for user ${userId}`);
}

async function setCredential(options: CliOptions): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  const reference = required(options, "ref");
  const value = required(options, "value");
  const credentials = await readCredentials(dir, key);

  if (typeof options.user === "string") {
    const user = credentials.users[options.user] ?? { apiKeys: [], credentials: {} };
    credentials.users[options.user] = {
      ...user,
      credentials: { ...user.credentials, [reference]: value },
    };
  } else if (typeof options.group === "string") {
    credentials.groups[options.group] = {
      ...(credentials.groups[options.group] ?? {}),
      [reference]: value,
    };
  } else {
    credentials.defaults[reference] = value;
  }

  await writeCredentials(dir, key, credentials);
  console.log(`Stored credential ${reference}`);
}

async function inspectAuth(options: CliOptions): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  const credentials = await readCredentials(dir, key);
  const upstreamAuth = JSON.parse(await readFile(path.join(dir, "upstream-auth.json"), "utf8")) as unknown;

  console.log(
    JSON.stringify(
      {
        credentials: {
          users: Object.fromEntries(
            Object.entries(credentials.users).map(([userId, user]) => [
              userId,
              {
                apiKeys: user.apiKeys.map(() => "<redacted>"),
                credentials: redactRecord(user.credentials),
              },
            ]),
          ),
          groups: Object.fromEntries(Object.entries(credentials.groups).map(([groupId, values]) => [groupId, redactRecord(values)])),
          defaults: redactRecord(credentials.defaults),
        },
        upstreamAuth,
      },
      null,
      2,
    ),
  );
}

async function readCredentials(dir: string, key: string): Promise<LocalCredentials> {
  return PantherAuth.decryptCredentials(JSON.parse(await readFile(path.join(dir, "credentials.enc.json"), "utf8")) as unknown, key);
}

async function writeCredentials(dir: string, key: string, credentials: LocalCredentials): Promise<void> {
  await writeFile(path.join(dir, "credentials.enc.json"), JSON.stringify(PantherAuth.encryptCredentials(credentials, key), null, 2));
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const name = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = value;
      index += 1;
    }
  }

  return options;
}

function required(options: CliOptions, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required --${name}`);
  }

  return value;
}

function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"]));
}

function printHelp(): void {
  console.log(`Usage:
  panther auth init --dir .panther/auth --key <key>
  panther auth set-api-key --dir .panther/auth --key <key> --user <id> --api-key <secret>
  panther auth set-credential --dir .panther/auth --key <key> --ref <name> --value <secret> [--user <id> | --group <id>]
  panther auth inspect --dir .panther/auth --key <key>`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
