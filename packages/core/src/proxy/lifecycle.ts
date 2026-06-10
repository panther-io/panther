import type { LifecycleHook, LifecycleHookEvent } from "../types/middleware.js";

export async function emitLifecycle(
  hooks: LifecycleHook[],
  event: LifecycleHookEvent,
  context: Parameters<LifecycleHook>[1],
): Promise<void> {
  for (const hook of hooks) {
    await hook(event, context);
  }
}
