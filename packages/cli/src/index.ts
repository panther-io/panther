#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main as runMain } from "./app/main.js";
import { discoverProject, ensureEmptyTargetDirectory, resolveProjectName, selectPackageManager } from "./domain/project/project.js";
import { renderEntrypoint, renderTemplate } from "./domain/template/template.js";
import { defaultRuntime } from "./platform/runtime.js";
import { parseCommand } from "./shared/parse.js";
import type { Runtime } from "./shared/types.js";

export { discoverProject, ensureEmptyTargetDirectory, parseCommand, renderEntrypoint, renderTemplate, resolveProjectName, selectPackageManager };
export type { Prompt, Runtime } from "./shared/types.js";

export function main(argv: string[], runtime: Runtime = defaultRuntime()): Promise<number> {
  return runMain(argv, runtime);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMain(process.argv.slice(2), defaultRuntime()).then((code) => {
    process.exitCode = code;
  });
}
