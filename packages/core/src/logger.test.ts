import { describe, expect, it } from "vitest";
import { Logger, type LogEntry, type LoggerDriver } from "./logger.js";

class MemoryDriver implements LoggerDriver {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("Logger redaction", () => {
  it("redacts sensitive context, annotations, metadata, arrays, and configured paths before writing", async () => {
    const driver = new MemoryDriver();
    const seen: LogEntry[] = [];
    const logger = new Logger({
      driver,
      context: { userId: "alice", authorization: "Bearer secret" },
      redact: { paths: ["nested.visible"] },
      onWrite: (entry) => seen.push(entry),
    });

    logger
      .child({ apiKey: "child-key" })
      .annotate("credential", "stored-token")
      .info("message", {
        password: "pw",
        nested: { visible: "hide-me", safe: "ok" },
        values: [{ token: "array-token" }],
      });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(driver.entries).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(driver.entries[0]?.context).toMatchObject({
      userId: "alice",
      authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
    expect(driver.entries[0]?.metadata).toMatchObject({
      credential: "[REDACTED]",
      password: "[REDACTED]",
      nested: { visible: "[REDACTED]", safe: "ok" },
      values: [{ token: "[REDACTED]" }],
    });
    expect(seen[0]).toEqual(driver.entries[0]);
  });

  it("can disable redaction for local debugging", () => {
    const driver = new MemoryDriver();
    const logger = new Logger({ driver, redact: false });

    logger.info("message", { token: "raw-token" });

    expect(driver.entries[0]?.metadata.token).toBe("raw-token");
  });
});
