export * from "./manifest.js";
export * from "./registry.js";
export * from "./loader.js";
export * from "./lifecycle.js";
export * from "./capabilities.js";

// Any shared type definitions for plugins go here.
export type PluginContext = Record<string, never>;
