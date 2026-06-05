declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
}

declare module "node:path" {
  const path: {
    join(...parts: string[]): string;
  };
  export default path;
}

declare const process: {
  argv: string[];
  exitCode?: number;
};
