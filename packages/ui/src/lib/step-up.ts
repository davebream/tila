/**
 * Step-up reauthentication resume state (#102).
 *
 * When a high-impact mutation is rejected with `step-up-required`, the panel
 * sends the user back through sign-in. GitHub sign-in lands on `/` with a
 * workspace session and no selected project, so the project and return path
 * are stashed in sessionStorage and replayed by `StepUpResume` once the user
 * is back. Nothing about the rejected mutation itself is stored; the user
 * repeats the action.
 */
const KEY = "tila.stepUp";

export type StepUpResumeState = { projectId: string; returnTo: string };

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function stashStepUpResume(state: StepUpResumeState): void {
  storage()?.setItem(KEY, JSON.stringify(state));
}

/** Read and clear the stash in one step so a resume never replays twice. */
export function takeStepUpResume(): StepUpResumeState | null {
  const store = storage();
  const raw = store?.getItem(KEY);
  if (!raw) return null;
  store?.removeItem(KEY);
  try {
    const parsed = JSON.parse(raw) as Partial<StepUpResumeState>;
    if (
      typeof parsed.projectId === "string" &&
      typeof parsed.returnTo === "string" &&
      parsed.returnTo.startsWith("/")
    )
      return { projectId: parsed.projectId, returnTo: parsed.returnTo };
  } catch {
    /* corrupt stash is discarded */
  }
  return null;
}

export function peekStepUpResume(): StepUpResumeState | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StepUpResumeState;
  } catch {
    return null;
  }
}
