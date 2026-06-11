import { access, readFile, stat } from "node:fs/promises";
import type { CliOptions } from "./types.js";

export function required(options: CliOptions, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required --${name}`);
  }

  return value;
}

export function stringOption(options: CliOptions, name: string, defaultValue: string): string {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value : defaultValue;
}

export function numberOption(options: CliOptions, name: string, defaultValue: number): number {
  const value = options[name];
  if (typeof value !== "string") {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function randomToken(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"]));
}

export async function exists(filePath: string): Promise<boolean> {
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

export async function canAccess(filePath: string, mode: number): Promise<boolean> {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
