import type { PluginManifest } from "./manifest.js";

export interface PluginRegistration {
  manifest: PluginManifest;
  status: "installed" | "active" | "error" | "disabled";
}

export interface PluginRegistry {
  register(manifest: PluginManifest): Promise<void>;
  getPlugin(name: string): PluginRegistration | undefined;
  listPlugins(): PluginRegistration[];
}
