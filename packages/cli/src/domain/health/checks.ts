import { constants as fsConstants } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { authDir, supportedPackageManagers } from "../../shared/constants.js";
import type { HealthResult, ProjectDiscovery, Runtime } from "../../shared/types.js";
import { canAccess, exists, numberOption, readJson } from "../../shared/utils.js";

export async function getDoctorResults(runtime: Runtime, shouldFix: boolean): Promise<HealthResult[]> {
  const results: HealthResult[] = [
    {
      group: "Runtime",
      label: "Node.js",
      status: Number(process.versions.node.split(".")[0]) >= 20 ? "pass" : "fail",
      detail: `Detected ${process.versions.node}; Fentaris requires Node 20 or newer.`,
    },
    ...supportedPackageManagers.map((manager): HealthResult => ({
      group: "Runtime",
      label: manager,
      status: runtime.probe(manager, ["--version"]) ? "pass" : "warn",
      detail: runtime.probe(manager, ["--version"]) ? "Available" : "Not found",
    })),
    {
      group: "Runtime",
      label: "git",
      status: runtime.probe("git", ["--version"]) ? "pass" : "fail",
      detail: runtime.probe("git", ["--version"]) ? "Available" : "Required for project initialization.",
    },
    {
      group: "Runtime",
      label: "Docker",
      status: runtime.probe("docker", ["--version"]) ? "pass" : "warn",
      detail: runtime.probe("docker", ["--version"]) ? "Available" : "Optional for future container workflows.",
    },
    await cliDirectoryResult(runtime.cwd),
    await writableResult(runtime.cwd),
    await portResult(numberOption({}, "port", 4000)),
  ];

  if (shouldFix) {
    for (const result of results.filter((item) => item.fix)) {
      if (await runtime.prompt.confirm(`Apply fix for ${result.label}?`)) {
        await result.fix?.();
      }
    }
  }

  return results;
}

export async function getProjectCheckResults(project: ProjectDiscovery, offline: boolean): Promise<HealthResult[]> {
  const expectedFiles = [
    "package.json",
    "tsconfig.json",
    "fentaris.config.json",
    ".env.example",
    ".gitignore",
    "README.md",
    project.config.entrypoint,
    path.join(project.config.authDir, "credentials.enc.json"),
    path.join(project.config.authDir, "upstream-auth.json"),
  ];
  const results: HealthResult[] = [];

  for (const file of expectedFiles) {
    const fileExists = await exists(path.join(project.root, file));
    results.push({
      group: "Files",
      label: file,
      status: fileExists ? "pass" : "fail",
      detail: fileExists ? "Found" : "Missing",
    });
  }

  const packageJson = await readJson(path.join(project.root, "package.json"));
  results.push({
    group: "Package",
    label: "package metadata",
    status: hasPackageMetadata(packageJson) ? "pass" : "fail",
    detail: hasPackageMetadata(packageJson) ? "Fentaris scripts and dependency are present." : "Expected @fentaris/core dependency and dev/build scripts.",
  });

  results.push({
    group: "Auth",
    label: "local auth references",
    status: project.config.authDir === authDir ? "pass" : "warn",
    detail: `Using ${project.config.authDir}`,
  });

  for (const upstream of project.config.upstreams ?? []) {
    if (offline) {
      results.push({ group: "MCP", label: upstream.name, status: "warn", detail: "Skipped connectivity in offline mode." });
    } else if (upstream.type === "http" && upstream.url) {
      results.push(await httpUpstreamResult(upstream.name, upstream.url));
    } else {
      results.push({
        group: "MCP",
        label: upstream.name,
        status: upstream.command ? "pass" : "fail",
        detail: upstream.command ? `Configured stdio command ${upstream.command}` : "Missing stdio command.",
      });
    }
  }

  return results;
}

export function hasFailure(results: HealthResult[]): boolean {
  return results.some((result) => result.status === "fail");
}

export function hasWarning(results: HealthResult[]): boolean {
  return results.some((result) => result.status === "warn");
}

function hasPackageMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const packageJson = value as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
  return Boolean(packageJson.dependencies?.["@fentaris/core"] && packageJson.scripts?.dev && packageJson.scripts?.build);
}

async function writableResult(dir: string): Promise<HealthResult> {
  const writable = await canAccess(dir, fsConstants.W_OK);
  return {
    group: "Filesystem",
    label: "CLI writable directory",
    status: writable ? "pass" : "fail",
    detail: writable ? `Writable: ${dir}` : `Cannot write to ${dir}`,
  };
}

async function cliDirectoryResult(cwd: string): Promise<HealthResult> {
  const cliDir = path.join(cwd, ".fentaris");
  const present = await exists(cliDir);
  return {
    group: "Filesystem",
    label: "CLI local directory",
    status: present ? "pass" : "warn",
    detail: present ? `Found ${cliDir}` : `Missing ${cliDir}; doctor --fix can create it.`,
    fix: async () => {
      await mkdir(cliDir, { recursive: true });
    },
  };
}

async function portResult(port: number): Promise<HealthResult> {
  return {
    group: "Network",
    label: `localhost:${port}`,
    status: "pass",
    detail: "Port check is deferred to runtime startup.",
  };
}

async function httpUpstreamResult(name: string, url: string): Promise<HealthResult> {
  if (!url.startsWith("https://")) {
    return {
      group: "MCP",
      label: name,
      status: "warn",
      detail: `Configured non-HTTPS HTTP upstream ${url}.`,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    return {
      group: "MCP",
      label: name,
      status: response.ok || response.status === 405 ? "pass" : "fail",
      detail: `Connectivity checked for ${url}; tool discovery will run when the project starts.`,
    };
  } catch (error: unknown) {
    return {
      group: "MCP",
      label: name,
      status: "fail",
      detail: `Unable to reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
