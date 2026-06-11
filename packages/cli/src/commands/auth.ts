import { addUserApiKey, initLocalAuth, inspectAuthFiles, storeCredential } from "../domain/auth/local-store.js";
import type { CliCommand, CliOptions, Runtime } from "../shared/types.js";
import { required } from "../shared/utils.js";
import { printHelp, style } from "../ui/format.js";

export async function runLegacyAuth(command: CliCommand, runtime: Runtime): Promise<void> {
  const [action] = command.args;
  if (action === "init") {
    await initAuth(command.options, runtime);
  } else if (action === "set-api-key") {
    await setApiKey(command.options, runtime);
  } else if (action === "set-credential") {
    await setCredential(command.options, runtime);
  } else if (action === "inspect") {
    await inspectAuth(command.options, runtime);
  } else {
    printHelp(runtime);
  }
}

async function initAuth(options: CliOptions, runtime: Runtime): Promise<void> {
  const dir = required(options, "dir");
  required(options, "key");
  await initLocalAuth(options);
  runtime.out.log(style.pass(`Initialized local auth files in ${dir}`));
}

async function setApiKey(options: CliOptions, runtime: Runtime): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  const userId = required(options, "user");
  const apiKey = required(options, "api-key");
  await addUserApiKey(dir, key, userId, apiKey);
  runtime.out.log(style.pass(`Stored API key hash for user ${userId}`));
}

async function setCredential(options: CliOptions, runtime: Runtime): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  const reference = required(options, "ref");
  const value = required(options, "value");
  await storeCredential(dir, key, reference, value, options);
  runtime.out.log(style.pass(`Stored credential ${reference}`));
}

async function inspectAuth(options: CliOptions, runtime: Runtime): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  runtime.out.log(JSON.stringify(await inspectAuthFiles(dir, key), null, 2));
}
