/**
 * Severity assigned to a configuration diagnostic.
 * @pk
 */
export type FentarisDiagnosticSeverity = "error" | "warning" | "info";

/**
 * Semantic path into a TypeScript Fentaris config object.
 * @pk
 */
export type FentarisConfigPath = Array<string | number>;

/**
 * Additional config location related to a diagnostic.
 * @pk
 */
export type FentarisDiagnosticRelatedEntry = {
  path?: FentarisConfigPath;
  message: string;
};

/**
 * Suggested remediation for a configuration diagnostic.
 * @pk
 */
export type FentarisDiagnosticSuggestion = {
  title: string;
  message?: string;
  path?: FentarisConfigPath;
};

/**
 * Structured, renderer-independent configuration diagnostic.
 * @pk
 */
export type FentarisDiagnostic = {
  severity: FentarisDiagnosticSeverity;
  code: string;
  title: string;
  message: string;
  path?: FentarisConfigPath;
  hint?: string;
  docsUrl?: string;
  related?: FentarisDiagnosticRelatedEntry[];
  suggestions?: FentarisDiagnosticSuggestion[];
};

/**
 * Diagnostic formatter mode.
 * @pk
 */
export type FentarisDiagnosticFormat = "pretty" | "plain" | "compact" | "json";

/**
 * Options for rendering diagnostics.
 * @pk
 */
export type FentarisDiagnosticFormatterOptions = {
  format?: FentarisDiagnosticFormat;
  color?: "auto" | "always" | "never" | boolean;
  unicode?: "auto" | "always" | "never" | boolean;
  includeWarnings?: boolean;
  includeInfo?: boolean;
  terminal?: {
    isTTY?: boolean;
    env?: Record<string, string | undefined>;
  };
};

/**
 * Result returned from explicit config validation.
 * @pk
 */
export type FentarisConfigValidationResult = {
  valid: boolean;
  diagnostics: FentarisDiagnostic[];
  errors: FentarisDiagnostic[];
  warnings: FentarisDiagnostic[];
  infos: FentarisDiagnostic[];
};

export function diagnostic(
  severity: FentarisDiagnosticSeverity,
  code: string,
  title: string,
  message: string,
  options: Omit<FentarisDiagnostic, "severity" | "code" | "title" | "message"> = {},
): FentarisDiagnostic {
  return { severity, code, title, message, ...options };
}

export function formatPath(path: FentarisConfigPath | undefined): string {
  if (!path || path.length === 0) {
    return "<config>";
  }

  return path.reduce<string>((result, part) => {
    if (typeof part === "number") {
      return `${result}[${part}]`;
    }

    if (!result) {
      return part;
    }

    return `${result}.${part}`;
  }, "");
}

export function toValidationResult(diagnostics: FentarisDiagnostic[]): FentarisConfigValidationResult {
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  const warnings = diagnostics.filter((entry) => entry.severity === "warning");
  const infos = diagnostics.filter((entry) => entry.severity === "info");

  return {
    valid: errors.length === 0,
    diagnostics,
    errors,
    warnings,
    infos,
  };
}
