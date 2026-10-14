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
// Distinguish a fresh helper write even when its destination is unchanged.
let writeVersion = 0;

export type StepUpResumeState = { projectId: string; returnTo: string };
export type StepUpResumeSnapshot = {
  raw: string | null;
  state: StepUpResumeState | null;
  writeVersion: number;
};

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function stashStepUpResume(state: StepUpResumeState): void {
  storage()?.setItem(KEY, JSON.stringify(state));
  writeVersion += 1;
}

function parseStepUpResume(raw: string | null): StepUpResumeState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StepUpResumeState>;
    if (
      !parsed ||
      typeof parsed.projectId !== "string" ||
      !parsed.projectId ||
      typeof parsed.returnTo !== "string" ||
      !parsed.returnTo.startsWith("/p/") ||
      parsed.returnTo.includes("\\")
    )
      return null;

    // Validate the browser-normalized path as well as the project segment.
    // Dot segments, including encoded ones, must not escape the project.
    const url = new URL(parsed.returnTo, "https://tila.invalid");
    const project = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    if (
      url.origin !== "https://tila.invalid" ||
      url.pathname !== parsed.returnTo.split(/[?#]/, 1)[0] ||
      project !== parsed.projectId ||
      project.includes("/") ||
      project.includes("\\")
    )
      return null;
    return { projectId: parsed.projectId, returnTo: parsed.returnTo };
  } catch {
    return null;
  }
}

/** Read without mutating storage, including when the stash is malformed. */
export function readStepUpResume(): StepUpResumeSnapshot {
  const raw = storage()?.getItem(KEY) ?? null;
  return { raw, state: parseStepUpResume(raw), writeVersion };
}

/** Clear only the captured stash; later writes belong to a new resume. */
export function takeStepUpResume(
  snapshot = readStepUpResume(),
): StepUpResumeState | null {
  const store = storage();
  if (
    snapshot.raw === null ||
    snapshot.writeVersion !== writeVersion ||
    store?.getItem(KEY) !== snapshot.raw
  )
    return null;
  store.removeItem(KEY);
  return snapshot.state;
}

export function peekStepUpResume(): StepUpResumeState | null {
  return readStepUpResume().state;
}
