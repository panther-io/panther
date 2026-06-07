import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type {
  ClientElicitationFeatureConfig,
  ClientFeaturesConfig,
  ClientRootsFeatureConfig,
  ClientSamplingFeatureConfig,
} from "./types.js";

export type ClientFeatureName = "roots" | "sampling" | "elicitation";

export function createClientCapabilities(config: ClientFeaturesConfig | undefined): ClientCapabilities {
  const capabilities: ClientCapabilities = {};

  if (isRootsEnabled(config?.roots)) {
    capabilities.roots = {
      listChanged: config?.roots?.mode === "pass-through" ? config.roots.listChanged : undefined,
    };
  }

  if (isSamplingEnabled(config?.sampling)) {
    capabilities.sampling = {};
  }

  if (isElicitationEnabled(config?.elicitation)) {
    capabilities.elicitation = {
      form: {},
    };
  }

  return capabilities;
}

export function isClientFeatureEnabled(config: ClientFeaturesConfig | undefined, feature: ClientFeatureName): boolean {
  if (feature === "roots") {
    return isRootsEnabled(config?.roots);
  }

  if (feature === "sampling") {
    return isSamplingEnabled(config?.sampling);
  }

  return isElicitationEnabled(config?.elicitation);
}

function isRootsEnabled(config: ClientRootsFeatureConfig | undefined): boolean {
  return Boolean(config?.enabled && hasFulfillment(config.mode, Boolean(config.resolver)));
}

function isSamplingEnabled(config: ClientSamplingFeatureConfig | undefined): boolean {
  return Boolean(config?.enabled && hasFulfillment(config.mode, Boolean(config.resolver)));
}

function isElicitationEnabled(config: ClientElicitationFeatureConfig | undefined): boolean {
  return Boolean(config?.enabled && hasFulfillment(config.mode, Boolean(config.resolver)));
}

function hasFulfillment(mode: "pass-through" | "resolver" | undefined, hasResolver: boolean): boolean {
  if (!mode) {
    return false;
  }

  if (mode === "resolver") {
    return hasResolver;
  }

  return true;
}
