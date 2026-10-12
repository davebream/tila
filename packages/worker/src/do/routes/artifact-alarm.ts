import type { RouterDeps } from "./types";
export async function scheduleArtifactPublication(
  deps: RouterDeps,
): Promise<void> {
  const next = Date.now() + 5000;
  const alarm = await deps.ctx.storage.getAlarm();
  if (alarm === null || alarm > next) await deps.ctx.storage.setAlarm(next);
}
