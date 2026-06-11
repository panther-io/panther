import type { CliCommand, CliOptions } from "./types.js";

export function parseCommand(argv: string[]): CliCommand {
  const args: string[] = [];
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }

    const name = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = value;
      index += 1;
    }
  }

  return { name: args[0] ?? "help", args: args.slice(1), options };
}
