import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { PantherAuth } from "@panther/core";
import { discoverProject, ensureEmptyTargetDirectory, main, parseCommand, renderTemplate, resolveProjectName, selectPackageManager, type Prompt, type Runtime } from "./index.js";

function prompt(values: string[] = []): Prompt {
  return {
    text: vi.fn(async () => values.shift() ?? ""),
    select: async <T extends string>(_question: string, choices: T[]) => choices[0],
    confirm: vi.fn(async () => true),
    close: vi.fn(),
  };
}

function runtime(cwd: string, probes: Record<string, boolean> = {}): Runtime & { calls: Array<{ command: string; args: string[]; cwd?: string | URL }> } {
  const calls: Array<{ command: string; args: string[]; cwd?: string | URL }> = [];
  return {
    cwd,
    env: { PANTHER_AUTH_KEY: "test-key" },
    out: { log: vi.fn(), error: vi.fn() },
    runner: vi.fn(async (command: string, args: string[], options?: SpawnOptions) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { code: 0 };
    }),
    probe: vi.fn((command: string) => probes[command] ?? false),
    prompt: prompt(["secret-value"]),
    calls,
  };
}

describe("command routing helpers", () => {
  it("parses nested commands and options", () => {
    expect(parseCommand(["secrets", "set", "github.token", "--user", "alice"])).toEqual({
      name: "secrets",
      args: ["set", "github.token"],
      options: { user: "alice" },
    });
  });

  it("resolves provided and prompted project names", async () => {
    await expect(resolveProjectName("my-app", prompt())).resolves.toBe("my-app");
    await expect(resolveProjectName(undefined, prompt(["asked-app"]))).resolves.toBe("asked-app");
  });

  it("rejects non-empty target directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    await writeFile(join(dir, "existing.txt"), "content");
    await expect(ensureEmptyTargetDirectory(dir)).rejects.toThrow("new or empty");
  });

  it("selects a package manager without prompting when only one exists", async () => {
    await expect(selectPackageManager((command) => command === "pnpm", prompt())).resolves.toBe("pnpm");
  });
});

describe("project template", () => {
  it("renders expected files and ignores local secrets", () => {
    const rendered = renderTemplate({
      projectName: "demo",
      packageManager: "pnpm",
      port: 4000,
      proxyPath: "/mcp",
      authKey: "auth-key",
      guestApiKey: "guest-key",
      adminApiKey: "admin-key",
    });

    expect(Object.keys(rendered.files).sort()).toEqual([
      ".env.example",
      ".gitignore",
      "demo-files/README.md",
      "package.json",
      "panther.config.json",
      "src/index.ts",
      "tsconfig.json",
    ]);
    expect(rendered.files[".gitignore"]).toContain(".panther/auth/");
    expect(rendered.files["src/index.ts"]).toContain("https://mcp.specification.website/mcp");
    expect(rendered.files["src/index.ts"]).toContain("rateLimitMiddleware");
    expect(rendered.files["src/index.ts"]).toContain("admin-full-access");
  });
});

describe("project commands", () => {
  it("initializes a project with dry-run install and git commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });

    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    const config = JSON.parse(await readFile(join(dir, "demo", "panther.config.json"), "utf8")) as { name: string };
    expect(config.name).toBe("demo");
    expect(rt.calls.some((call) => call.command === "git" && call.args[0] === "init")).toBe(true);
  });

  it("discovers projects from nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const srcDir = join(dir, "src", "nested");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(dir, "panther.config.json"),
      JSON.stringify({ name: "demo", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: ".panther/auth" }),
    );

    await expect(discoverProject(srcDir)).resolves.toMatchObject({ root: dir });
  });

  it("runs dev through the discovered package manager", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo", "src");
    await expect(main(["dev"], rt)).resolves.toBe(0);

    expect(rt.calls.some((call) => call.command === "pnpm" && call.args.join(" ") === "dev")).toBe(true);
  });

  it("builds a deterministic local artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    await expect(main(["build"], rt)).resolves.toBe(0);

    const manifest = JSON.parse(await readFile(join(dir, "demo", ".panther", "build", "manifest.json"), "utf8")) as { entrypoint: string };
    expect(manifest.entrypoint).toBe("src/index.ts");
    expect(rt.calls.some((call) => call.command === "pnpm" && call.args.join(" ") === "run build")).toBe(true);
  });

  it("validates check modes and strict warning exit behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    await expect(main(["check", "--offline"], rt)).resolves.toBe(0);
    await expect(main(["check", "--offline", "--strict"], rt)).resolves.toBe(1);
    await expect(main(["doctor", "--strict"], rt)).resolves.toBe(1);
  });

  it("prompts before applying doctor fixes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["doctor", "--fix"], rt)).resolves.toBe(0);

    expect(rt.prompt.confirm).toHaveBeenCalledWith("Apply fix for CLI local directory?");
    await expect(readdir(join(dir, ".panther"))).resolves.toEqual([]);
  });

  it("reports deploy as a placeholder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const rt = runtime(dir);
    await expect(main(["deploy"], rt)).resolves.toBe(0);
    expect(rt.out.log).toHaveBeenCalledWith(expect.stringContaining("Deploy is not available yet"));
  });
});

describe("secrets", () => {
  it("stores redacted user secrets in PantherAuth-compatible credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panther-cli-"));
    const project = join(dir, "project");
    const authDir = join(project, ".panther", "auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(project, "panther.config.json"),
      JSON.stringify({ name: "demo", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: ".panther/auth" }),
    );
    await writeFile(
      join(authDir, "credentials.enc.json"),
      JSON.stringify(PantherAuth.encryptCredentials({ users: {}, groups: {}, defaults: {} }, "test-key")),
    );
    await writeFile(join(authDir, "upstream-auth.json"), JSON.stringify({ servers: {} }));

    const rt = runtime(project);
    await expect(main(["secrets", "set", "github.token", "--user", "alice"], rt)).resolves.toBe(0);

    const credentials = PantherAuth.decryptCredentials(JSON.parse(await readFile(join(authDir, "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.users.alice?.credentials["github.token"]).toBe("secret-value");
    expect(rt.out.log).toHaveBeenCalledWith("Value: <redacted>");
  });
});
