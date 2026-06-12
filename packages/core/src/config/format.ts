import { formatPath, type FentarisDiagnostic, type FentarisDiagnosticFormatterOptions } from "./diagnostics.js";

/**
 * Format diagnostics for humans or JSON-oriented tooling.
 * @pk
 */
export function formatFentarisDiagnostics(
  diagnostics: readonly FentarisDiagnostic[],
  options: FentarisDiagnosticFormatterOptions = {},
): string {
  const format = options.format ?? "pretty";
  const filtered = filterDiagnostics(diagnostics, options);

  if (format === "json") {
    return JSON.stringify(filtered, null, 2);
  }

  if (filtered.length === 0) {
    return "No Fentaris configuration diagnostics.";
  }

  if (format === "compact") {
    return filtered.map((entry) => `${entry.severity.toUpperCase()} ${entry.code} ${formatPath(entry.path)}: ${entry.message}`).join("\n");
  }

  if (format === "plain") {
    return renderPlain(filtered);
  }

  return renderPretty(filtered, options);
}

function filterDiagnostics(
  diagnostics: readonly FentarisDiagnostic[],
  options: FentarisDiagnosticFormatterOptions,
): FentarisDiagnostic[] {
  return diagnostics.filter((entry) => {
    if (entry.severity === "warning" && options.includeWarnings === false) {
      return false;
    }
    if (entry.severity === "info" && options.includeInfo === false) {
      return false;
    }
    return true;
  });
}

function renderPlain(diagnostics: readonly FentarisDiagnostic[]): string {
  const lines: string[] = ["Fentaris configuration diagnostics:"];
  for (const entry of diagnostics) {
    lines.push("");
    lines.push(`${entry.severity.toUpperCase()} ${entry.code}: ${entry.title}`);
    lines.push(`Path: ${formatPath(entry.path)}`);
    lines.push(entry.message);
    if (entry.hint) {
      lines.push(`Hint: ${entry.hint}`);
    }
    for (const related of entry.related ?? []) {
      lines.push(`Related ${formatPath(related.path)}: ${related.message}`);
    }
    for (const suggestion of entry.suggestions ?? []) {
      lines.push(`Suggestion: ${suggestion.title}${suggestion.message ? ` - ${suggestion.message}` : ""}`);
    }
  }
  return lines.join("\n");
}

function renderPretty(
  diagnostics: readonly FentarisDiagnostic[],
  options: FentarisDiagnosticFormatterOptions,
): string {
  const color = shouldUseColor(options);
  const unicode = shouldUseUnicode(options);
  const branch = unicode ? "├─" : "+-";
  const leaf = unicode ? "└─" : "`-";
  const lines: string[] = [style("Fentaris configuration diagnostics", "bold", color)];

  diagnostics.forEach((entry, index) => {
    const marker = index === diagnostics.length - 1 ? leaf : branch;
    lines.push("");
    lines.push(`${marker} ${style(entry.severity.toUpperCase(), entry.severity, color)} ${style(entry.code, "code", color)} ${entry.title}`);
    lines.push(`   at ${formatPath(entry.path)}`);
    lines.push(`   ${entry.message}`);
    if (entry.hint) {
      lines.push(`   hint: ${entry.hint}`);
    }
    if (entry.related?.length) {
      lines.push("   related:");
      for (const related of entry.related) {
        lines.push(`   - ${formatPath(related.path)}: ${related.message}`);
      }
    }
    if (entry.suggestions?.length) {
      lines.push("   suggestions:");
      for (const suggestion of entry.suggestions) {
        lines.push(`   - ${suggestion.title}${suggestion.message ? `: ${suggestion.message}` : ""}`);
      }
    }
  });

  return lines.join("\n");
}

function shouldUseColor(options: FentarisDiagnosticFormatterOptions): boolean {
  if (options.color === false || options.color === "never") {
    return false;
  }
  if (options.color === true || options.color === "always") {
    return true;
  }

  const env = options.terminal?.env ?? process.env;
  if (env.NO_COLOR || env.CI) {
    return false;
  }

  return Boolean(options.terminal?.isTTY ?? process.stdout.isTTY);
}

function shouldUseUnicode(options: FentarisDiagnosticFormatterOptions): boolean {
  if (options.unicode === false || options.unicode === "never") {
    return false;
  }
  if (options.unicode === true || options.unicode === "always") {
    return true;
  }

  const env = options.terminal?.env ?? process.env;
  return !env.CI;
}

function style(text: string, kind: "bold" | "code" | FentarisDiagnostic["severity"], color: boolean): string {
  if (!color) {
    return text;
  }

  const codes: Record<typeof kind, [number, number]> = {
    bold: [1, 22],
    code: [36, 39],
    error: [31, 39],
    warning: [33, 39],
    info: [34, 39],
  };
  const [open, close] = codes[kind];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}
