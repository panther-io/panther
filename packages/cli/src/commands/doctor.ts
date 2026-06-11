import { getDoctorResults, hasFailure, hasWarning } from "../domain/health/checks.js";
import type { CliCommand, Runtime } from "../shared/types.js";
import { printHealthResults, section } from "../ui/format.js";

export async function runDoctor(command: CliCommand, runtime: Runtime): Promise<void> {
  section(runtime, "Doctor");
  const results = await getDoctorResults(runtime, command.options.fix === true);
  printHealthResults(runtime, results);
  if (hasFailure(results) || (command.options.strict === true && hasWarning(results))) {
    throw new Error("Doctor reported issues.");
  }
}
