#!/usr/bin/env node
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PantherAuth, type LocalCredentials } from "@panther/core";

type CliOptions = Record<string, string | boolean>;
type CliCommand = {
  name: string;
  args: string[];
  options: CliOptions;
};
type PackageManager = "pnpm" | "npm" | "bun";
type CommandResult = { code: number };
type ProcessRunner = (command: string, args: string[], options?: SpawnOptions) => Promise<CommandResult>;
type ExecProbe = (command: string, args?: string[]) => boolean;
export type Prompt = {
  text(question: string, options?: { secret?: boolean; defaultValue?: string }): Promise<string>;
  select<T extends string>(question: string, choices: T[]): Promise<T>;
  confirm(question: string): Promise<boolean>;
  close(): void;
};
export type Runtime = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: Pick<typeof console, "log" | "error">;
  runner: ProcessRunner;
  probe: ExecProbe;
  prompt: Prompt;
};
type TemplateInput = {
  projectName: string;
  packageManager: PackageManager;
  port: number;
  proxyPath: string;
  authKey: string;
  guestApiKey: string;
  adminApiKey: string;
};
type HealthStatus = "pass" | "warn" | "fail";
type HealthResult = {
  group: string;
  label: string;
  status: HealthStatus;
  detail: string;
  fix?: () => Promise<void>;
};
type ProjectConfig = {
  name: string;
  packageManager: PackageManager;
  entrypoint: string;
  port: number;
  path: string;
  authDir: string;
  upstreams?: Array<{ name: string; type: "stdio" | "http"; url?: string; command?: string; args?: string[] }>;
};
type ProjectDiscovery = { root: string; configPath: string; config: ProjectConfig };

const supportedPackageManagers: PackageManager[] = ["pnpm", "npm", "bun"];
const authDir = ".panther/auth";
const buildDir = ".panther/build";
const remoteMcpUrl = "https://mcp.specification.website/mcp";
const cliVersion = "0.1.0";

export async function main(argv: string[], runtime = defaultRuntime()): Promise<number> {
  const command = parseCommand(argv);

  try {
    await route(command, runtime);
    return 0;
  } catch (error: unknown) {
    runtime.out.error(style.fail(error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    runtime.prompt.close();
  }
}

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

async function route(command: CliCommand, runtime: Runtime): Promise<void> {
  if (command.name === "help" || command.options.help === true) {
    printHelp(runtime);
    return;
  }

  if (command.name === "version") {
    runtime.out.log(cliVersion);
    return;
  }

  if (command.name === "auth") {
    await runLegacyAuth(command, runtime);
    return;
  }

  if (command.name === "secrets") {
    await runSecrets(command, runtime);
    return;
  }

  if (command.name === "init") {
    await runInit(command, runtime);
    return;
  }

  if (command.name === "doctor") {
    await runDoctor(command, runtime);
    return;
  }

  if (command.name === "check") {
    await runCheck(command, runtime);
    return;
  }

  if (command.name === "dev") {
    await runDev(command, runtime);
    return;
  }

  if (command.name === "build") {
    await runBuild(command, runtime);
    return;
  }

  throw new Error(`Unknown command "${command.name}". Run panther help.`);
}

async function runInit(command: CliCommand, runtime: Runtime): Promise<void> {
  const projectName = await resolveProjectName(command.args[0], runtime.prompt);
  const targetDir = path.resolve(runtime.cwd, projectName);
  await ensureEmptyTargetDirectory(targetDir);

  const packageManager = await selectPackageManager(runtime.probe, runtime.prompt);
  const template = renderTemplate({
    projectName,
    packageManager,
    port: numberOption(command.options, "port", 4000),
    proxyPath: stringOption(command.options, "path", "/mcp"),
    authKey: randomToken("panther-auth"),
    guestApiKey: randomToken("guest"),
    adminApiKey: randomToken("admin"),
  });

  section(runtime, "Create Project");
  await writeTemplate(targetDir, template.files);
  await initTemplateAuth(path.join(targetDir, authDir), template.authKey, template.guestApiKey, template.adminApiKey);
  runtime.out.log(style.pass(`Created ${projectName}`));

  section(runtime, "Install");
  if (command.options["skip-install"] === true) {
    runtime.out.log(style.warn("Skipped dependency install by request."));
  } else {
    await runPackageInstall(packageManager, targetDir, runtime.runner);
    runtime.out.log(style.pass(`Installed dependencies with ${packageManager}`));
  }

  section(runtime, "Git");
  await runtime.runner("git", ["init"], { cwd: targetDir, stdio: "ignore" });
  runtime.out.log(style.pass("Initialized git repository"));

  section(runtime, "Doctor");
  const doctorResults = await getDoctorResults({ ...runtime, cwd: targetDir }, false);
  printHealthResults(runtime, doctorResults);

  section(runtime, "Next Steps");
  runtime.out.log(`Demo guest API key: ${template.guestApiKey}`);
  runtime.out.log(`Demo admin API key: ${template.adminApiKey}`);
  runtime.out.log(nextSteps([`cd ${projectName}`, "panther dev"]));
}

export async function resolveProjectName(provided: string | undefined, prompt: Prompt): Promise<string> {
  const value = provided?.trim() || (await prompt.text("Project name"));
  if (!value.trim()) {
    throw new Error("Project name is required.");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error("Project name may only contain letters, numbers, dots, underscores, and hyphens.");
  }

  return value;
}

export async function ensureEmptyTargetDirectory(targetDir: string): Promise<void> {
  try {
    const current = await readdir(targetDir);
    if (current.length > 0) {
      throw new Error(`Panther can only initialize into a new or empty directory: ${targetDir}`);
    }
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }

    throw error;
  }
}

export async function selectPackageManager(probe: ExecProbe, prompt: Prompt): Promise<PackageManager> {
  const available = supportedPackageManagers.filter((manager) => probe(manager, ["--version"]));
  if (available.length === 0) {
    throw new Error("No supported package manager found. Install pnpm, npm, or bun.");
  }

  if (available.length === 1) {
    return available[0];
  }

  return prompt.select("Package manager", available);
}

async function runDoctor(command: CliCommand, runtime: Runtime): Promise<void> {
  section(runtime, "Doctor");
  const results = await getDoctorResults(runtime, command.options.fix === true);
  printHealthResults(runtime, results);
  if (hasFailure(results) || (command.options.strict === true && hasWarning(results))) {
    throw new Error("Doctor reported issues.");
  }
}

async function getDoctorResults(runtime: Runtime, shouldFix: boolean): Promise<HealthResult[]> {
  const results: HealthResult[] = [
    {
      group: "Runtime",
      label: "Node.js",
      status: Number(process.versions.node.split(".")[0]) >= 20 ? "pass" : "fail",
      detail: `Detected ${process.versions.node}; Panther requires Node 20 or newer.`,
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

async function runCheck(command: CliCommand, runtime: Runtime): Promise<void> {
  section(runtime, "Project Check");
  const project = await discoverProject(runtime.cwd);
  const results = await getProjectCheckResults(project, command.options.offline === true);
  printHealthResults(runtime, results);
  if (hasFailure(results) || (command.options.strict === true && hasWarning(results))) {
    throw new Error("Project check reported issues.");
  }
}

async function getProjectCheckResults(project: ProjectDiscovery, offline: boolean): Promise<HealthResult[]> {
  const expectedFiles = [
    "package.json",
    "tsconfig.json",
    "panther.config.json",
    ".env.example",
    ".gitignore",
    project.config.entrypoint,
    path.join(project.config.authDir, "credentials.enc.json"),
    path.join(project.config.authDir, "upstream-auth.json"),
  ];
  const results: HealthResult[] = [];

  for (const file of expectedFiles) {
    results.push({
      group: "Files",
      label: file,
      status: (await exists(path.join(project.root, file))) ? "pass" : "fail",
      detail: (await exists(path.join(project.root, file))) ? "Found" : "Missing",
    });
  }

  const packageJson = await readJson(path.join(project.root, "package.json"));
  results.push({
    group: "Package",
    label: "package metadata",
    status: hasPackageMetadata(packageJson) ? "pass" : "fail",
    detail: hasPackageMetadata(packageJson) ? "Panther scripts and dependency are present." : "Expected @panther/core dependency and dev/build scripts.",
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

async function runDev(_command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
  section(runtime, "Dev");
  runtime.out.log(style.pass(`Starting ${project.config.name} at http://localhost:${project.config.port}${project.config.path}`));
  await runPackageScript(project.config.packageManager, project.root, "dev", runtime.runner);
}

async function runBuild(_command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
  const results = await getProjectCheckResults(project, true);
  if (hasFailure(results)) {
    printHealthResults(runtime, results);
    throw new Error("Build requires a valid Panther project.");
  }

  section(runtime, "Build");
  await runPackageScript(project.config.packageManager, project.root, "build", runtime.runner);
  const outputDir = path.join(project.root, buildDir);
  await mkdir(outputDir, { recursive: true });
  await copyFile(path.join(project.root, "package.json"), path.join(outputDir, "package.json"));
  await writeFile(
    path.join(outputDir, "manifest.json"),
    JSON.stringify(
      {
        name: project.config.name,
        entrypoint: project.config.entrypoint,
        createdBy: `panther ${cliVersion}`,
      },
      null,
      2,
    ),
  );
  runtime.out.log(style.pass(`Build output: ${path.relative(runtime.cwd, outputDir)}`));
  runtime.out.log(`Runtime entrypoint: ${project.config.entrypoint}`);
}

async function runSecrets(command: CliCommand, runtime: Runtime): Promise<void> {
  const [action, reference] = command.args;
  if (action !== "set" || !reference) {
    throw new Error("Usage: panther secrets set <reference> [--user <id> | --group <id>]");
  }

  if (typeof command.options.user === "string" && typeof command.options.group === "string") {
    throw new Error("Use either --user or --group, not both.");
  }

  const project = await discoverProject(runtime.cwd);
  const key = await authKeyFromRuntime(runtime, command.options);
  const value = typeof command.options.value === "string" ? command.options.value : await runtime.prompt.text(`Secret value for ${reference}`, { secret: true });
  await storeCredential(path.join(project.root, project.config.authDir), key, reference, value, command.options);
  section(runtime, "Secrets");
  runtime.out.log(style.pass(`Stored ${reference} as ${secretScope(command.options)} credential.`));
  runtime.out.log("Value: <redacted>");
}

async function runLegacyAuth(command: CliCommand, runtime: Runtime): Promise<void> {
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
  const key = required(options, "key");
  await mkdir(dir, { recursive: true });
  await writeCredentials(dir, key, { users: {}, groups: {}, defaults: {} });
  await writeFile(path.join(dir, "upstream-auth.json"), JSON.stringify({ servers: {} }, null, 2));
  runtime.out.log(style.pass(`Initialized local auth files in ${dir}`));
}

async function setApiKey(options: CliOptions, runtime: Runtime): Promise<void> {
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

async function storeCredential(dir: string, key: string, reference: string, value: string, options: CliOptions): Promise<void> {
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

async function inspectAuth(options: CliOptions, runtime: Runtime): Promise<void> {
  const dir = required(options, "dir");
  const key = required(options, "key");
  const credentials = await readCredentials(dir, key);
  const upstreamAuth = JSON.parse(await readFile(path.join(dir, "upstream-auth.json"), "utf8")) as unknown;

  runtime.out.log(
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
  );
}

export function renderTemplate(input: TemplateInput): { files: Record<string, string>; authKey: string; guestApiKey: string; adminApiKey: string } {
  return {
    authKey: input.authKey,
    guestApiKey: input.guestApiKey,
    adminApiKey: input.adminApiKey,
    files: {
      "package.json": JSON.stringify(
        {
          name: input.projectName,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx src/index.ts",
            build: "tsc -p tsconfig.json",
            start: "node dist/index.js",
          },
          dependencies: {
            "@modelcontextprotocol/server-filesystem": "latest",
            "@panther/core": "latest",
            tsx: "latest",
          },
          devDependencies: {
            typescript: "latest",
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            outDir: "dist",
            rootDir: "src",
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "panther.config.json": JSON.stringify(
        {
          name: input.projectName,
          packageManager: input.packageManager,
          entrypoint: "src/index.ts",
          port: input.port,
          path: input.proxyPath,
          authDir,
          upstreams: [
            {
              name: "demo-files",
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", "./demo-files"],
            },
            {
              name: "specification",
              type: "http",
              url: remoteMcpUrl,
            },
          ],
        },
        null,
        2,
      ),
      ".env.example": [
        `PANTHER_AUTH_KEY=${input.authKey}`,
        `PANTHER_GUEST_API_KEY=${input.guestApiKey}`,
        `PANTHER_ADMIN_API_KEY=${input.adminApiKey}`,
        `PANTHER_PORT=${input.port}`,
        `PANTHER_PATH=${input.proxyPath}`,
        "",
      ].join("\n"),
      ".gitignore": [
        "node_modules/",
        "dist/",
        ".env",
        ".env.*",
        "!.env.example",
        ".panther/auth/",
        ".panther/build/",
        "*.log",
        "",
      ].join("\n"),
      "src/index.ts": renderEntrypoint(input),
      "demo-files/README.md": "# Panther demo files\n\nThis directory is intentionally scoped for the demo filesystem MCP server.\n",
    },
  };
}

function renderEntrypoint(input: TemplateInput): string {
  return `import {
  McpProxy,
  McpServer,
  MemoryRateLimitStore,
  PantherAuth,
  Policy,
  SlidingWindowRateLimiter,
  StdioTransport,
  StreamableHttpMcpTransport,
  group,
  rateLimitMiddleware,
  user,
} from "@panther/core";

const port = Number(process.env.PANTHER_PORT ?? ${input.port});
const proxyPath = process.env.PANTHER_PATH ?? "${input.proxyPath}";
const authKey = process.env.PANTHER_AUTH_KEY ?? "${input.authKey}";

const auth = await PantherAuth.local({
  dir: ".panther/auth",
  key: authKey,
});

const guest = user("guest", { displayName: "Guest Demo User" });
const admin = user("admin", { displayName: "Admin Demo User" });

const limitedPolicy = new Policy({ name: "limited-demo" })
  .server("demo-files")
  .allow("list_allowed_directories")
  .server("demo-files")
  .allow("list_directory")
  .server("specification")
  .allow("*");

const adminPolicy = Policy.allowAll("admin-full-access");
const limiter = new SlidingWindowRateLimiter({
  store: new MemoryRateLimitStore(),
  maxPerWindow: 30,
  windowMs: 60_000,
});

const proxy = new McpProxy({
  port,
  path: proxyPath,
  auth,
  groups: [
    group({ id: "limited", users: [guest], policy: limitedPolicy }),
    group({ id: "admins", users: [admin], policy: adminPolicy }),
  ],
  servers: [
    new McpServer({
      name: "demo-files",
      transport: new StdioTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "./demo-files"],
      }),
    }),
    new McpServer({
      name: "specification",
      transport: new StreamableHttpMcpTransport({
        url: "${remoteMcpUrl}",
      }),
    }),
  ],
});

proxy.use(rateLimitMiddleware({ limiter }));

await proxy.start(() => {
  console.log(\`Panther proxy listening at http://localhost:\${port}\${proxyPath}\`);
  console.log("Use x-panther-api-key with the generated guest or admin key.");
});
`;
}

async function writeTemplate(targetDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

async function initTemplateAuth(dir: string, key: string, guestApiKey: string, adminApiKey: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeCredentials(dir, key, {
    users: {
      guest: { apiKeys: [PantherAuth.hashApiKey(guestApiKey)], credentials: {} },
      admin: { apiKeys: [PantherAuth.hashApiKey(adminApiKey)], credentials: {} },
    },
    groups: { limited: {} },
    defaults: {},
  });
  await writeFile(path.join(dir, "upstream-auth.json"), JSON.stringify({ servers: {}, credentialConflict: "first" }, null, 2));
}

export async function discoverProject(fromDir: string): Promise<ProjectDiscovery> {
  let current = path.resolve(fromDir);
  while (true) {
    const configPath = path.join(current, "panther.config.json");
    if (await exists(configPath)) {
      const config = validateProjectConfig(await readJson(configPath), configPath);
      return { root: current, configPath, config };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("No Panther project found. Run this command inside a generated Panther project.");
    }
    current = parent;
  }
}

function validateProjectConfig(value: unknown, configPath: string): ProjectConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid Panther config at ${configPath}`);
  }

  const config = value as Partial<ProjectConfig>;
  if (!config.name || !config.packageManager || !config.entrypoint || !config.port || !config.path || !config.authDir) {
    throw new Error(`Invalid Panther config at ${configPath}`);
  }

  if (!supportedPackageManagers.includes(config.packageManager)) {
    throw new Error(`Unsupported package manager in ${configPath}`);
  }

  return {
    name: config.name,
    packageManager: config.packageManager,
    entrypoint: config.entrypoint,
    port: config.port,
    path: config.path,
    authDir: config.authDir,
    upstreams: Array.isArray(config.upstreams) ? config.upstreams : [],
  };
}

async function runPackageInstall(packageManager: PackageManager, cwd: string, runner: ProcessRunner): Promise<void> {
  const result = await runner(packageManager, packageManager === "npm" ? ["install"] : ["install"], { cwd, stdio: "inherit" });
  if (result.code !== 0) {
    throw new Error(`${packageManager} install failed.`);
  }
}

async function runPackageScript(packageManager: PackageManager, cwd: string, script: string, runner: ProcessRunner): Promise<void> {
  const args = packageManager === "npm" ? ["run", script] : script === "dev" ? ["dev"] : ["run", script];
  const result = await runner(packageManager, args, { cwd, stdio: "inherit" });
  if (result.code !== 0) {
    throw new Error(`${packageManager} ${script} failed.`);
  }
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
  const cliDir = path.join(cwd, ".panther");
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

function printHealthResults(runtime: Runtime, results: HealthResult[]): void {
  const groups = Array.from(new Set(results.map((result) => result.group)));
  for (const groupName of groups) {
    runtime.out.log(style.heading(groupName));
    for (const result of results.filter((item) => item.group === groupName)) {
      runtime.out.log(`${marker(result.status)} ${result.label}: ${result.detail}`);
    }
  }
  const failCount = results.filter((result) => result.status === "fail").length;
  const warnCount = results.filter((result) => result.status === "warn").length;
  runtime.out.log(summary(results.length - failCount - warnCount, warnCount, failCount));
}

function hasFailure(results: HealthResult[]): boolean {
  return results.some((result) => result.status === "fail");
}

function hasWarning(results: HealthResult[]): boolean {
  return results.some((result) => result.status === "warn");
}

function hasPackageMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const packageJson = value as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
  return Boolean(packageJson.dependencies?.["@panther/core"] && packageJson.scripts?.dev && packageJson.scripts?.build);
}

function section(runtime: Runtime, title: string): void {
  runtime.out.log(style.heading(title));
}

const color = {
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
  bold: "\u001b[1m",
  reset: "\u001b[0m",
};

const style = {
  heading: (value: string) => `${color.bold}${color.cyan}${value}${color.reset}`,
  pass: (value: string) => `${color.green}✓ ${value}${color.reset}`,
  warn: (value: string) => `${color.yellow}! ${value}${color.reset}`,
  fail: (value: string) => `${color.red}✗ ${value}${color.reset}`,
};

function marker(status: HealthStatus): string {
  if (status === "pass") {
    return style.pass("");
  }
  if (status === "warn") {
    return style.warn("");
  }
  return style.fail("");
}

function summary(pass: number, warn: number, fail: number): string {
  return `Summary: ${pass} pass, ${warn} warn, ${fail} fail`;
}

function nextSteps(steps: string[]): string {
  return ["Next steps:", ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join("\n");
}

async function authKeyFromRuntime(runtime: Runtime, options: CliOptions): Promise<string> {
  if (typeof options.key === "string") {
    return options.key;
  }
  if (typeof runtime.env.PANTHER_AUTH_KEY === "string" && runtime.env.PANTHER_AUTH_KEY.trim()) {
    return runtime.env.PANTHER_AUTH_KEY;
  }
  return runtime.prompt.text("Local auth encryption key", { secret: true });
}

function secretScope(options: CliOptions): string {
  if (typeof options.user === "string") {
    return `user ${options.user}`;
  }
  if (typeof options.group === "string") {
    return `group ${options.group}`;
  }
  return "default";
}

async function readCredentials(dir: string, key: string): Promise<LocalCredentials> {
  return PantherAuth.decryptCredentials(JSON.parse(await readFile(path.join(dir, "credentials.enc.json"), "utf8")) as unknown, key);
}

async function writeCredentials(dir: string, key: string, credentials: LocalCredentials): Promise<void> {
  await writeFile(path.join(dir, "credentials.enc.json"), JSON.stringify(PantherAuth.encryptCredentials(credentials, key), null, 2));
}

function defaultRuntime(): Runtime {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: console,
    runner: runProcess,
    probe: (command, args = ["--version"]) => spawnSync(command, args, { stdio: "ignore" }).status === 0,
    prompt: createPrompt(),
  };
}

function createPrompt(): Prompt {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async text(question, options = {}) {
      const answer = await rl.question(`${question}${options.defaultValue ? ` (${options.defaultValue})` : ""}: `);
      return answer.trim() || options.defaultValue || "";
    },
    async select(question, choices) {
      const answer = await rl.question(`${question} (${choices.join("/")}): `);
      const selected = choices.find((choice) => choice === answer.trim());
      if (!selected) {
        throw new Error(`Expected one of: ${choices.join(", ")}`);
      }
      return selected;
    },
    async confirm(question) {
      const answer = await rl.question(`${question} [y/N]: `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    },
    close() {
      rl.close();
    },
  };
}

function runProcess(command: string, args: string[], options: SpawnOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
}

function required(options: CliOptions, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required --${name}`);
  }

  return value;
}

function stringOption(options: CliOptions, name: string, defaultValue: string): string {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value : defaultValue;
}

function numberOption(options: CliOptions, name: string, defaultValue: number): number {
  const value = options[name];
  if (typeof value !== "string") {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function randomToken(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"]));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function canAccess(filePath: string, mode: number): Promise<boolean> {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function printHelp(runtime: Runtime): void {
  runtime.out.log(`Usage:
  panther init [project-name] [--skip-install]
  panther dev
  panther check [--offline] [--strict]
  panther doctor [--fix]
  panther build
  panther secrets set <reference> [--user <id> | --group <id>]

Legacy local auth:
  panther auth init --dir .panther/auth --key <key>
  panther auth set-api-key --dir .panther/auth --key <key> --user <id> --api-key <secret>
  panther auth set-credential --dir .panther/auth --key <key> --ref <name> --value <secret> [--user <id> | --group <id>]
  panther auth inspect --dir .panther/auth --key <key>`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
