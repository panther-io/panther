import type { PluginManifest } from "./manifest.js";

export interface PluginLoader {
  load(name: string): Promise<PluginManifest>;
  // Placeholder for future loader methods
}
