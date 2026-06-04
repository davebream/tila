import { useCallback, useEffect, useState } from "react";
import { Kbd } from "./kbd";

const STORAGE_KEY = "tila-welcome-dismissed";

export function WelcomeBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    if (dismissed) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) dismiss();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [dismissed, dismiss]);

  if (dismissed) return null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: dismissible banner with role="region" is correct landmark pattern
    <div
      role="region"
      aria-label="Welcome"
      className="mx-6 mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-5 py-3"
    >
      <p className="text-sm text-muted-foreground">
        Read-only view of your project's coordination state. Press <Kbd>⌘K</Kbd>{" "}
        to search, navigate, or look up concepts.
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 cursor-pointer rounded-sm p-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label="Dismiss welcome message"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
