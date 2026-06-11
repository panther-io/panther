import path from "node:path";
import { authKeyFromRuntime, secretScope, storeCredential } from "../domain/auth/local-store.js";
import { discoverProject } from "../domain/project/project.js";
import type { CliCommand, Runtime } from "../shared/types.js";
import { section, style } from "../ui/format.js";

export async function runSecrets(command: CliCommand, runtime: Runtime): Promise<void> {
  const [action, reference] = command.args;
  if (action !== "set" || !reference) {
    throw new Error("Usage: fentaris secrets set <reference> [--user <id> | --group <id>]");
  }

  if (typeof command.options.user === "string" && typeof command.options.group === "string") {
    throw new Error("Use either --user or --group, not both.");
  }

  const project = await discoverProject(runtime.cwd);
  const key = await authKeyFromRuntime(runtime, command.options);
  const value = typeof command.options.value === "string" ? command.options.value : await runtime.prompt.text(`Secret value for ${reference}`, { secret: true });
  await storeCredential(path.join(project.root, project.config.authDir), key, reference, value, command.options);
  section(runtime, "Secrets");
  runtime.out.log(`  ${style.pass(`Stored ${reference} as ${secretScope(command.options)} credential.`)}`);
  runtime.out.log("Value: <redacted>");
}
