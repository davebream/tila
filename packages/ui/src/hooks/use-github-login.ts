import { githubLoginConfig } from "@/lib/api";
import { useEffect, useState } from "react";

/** Recheck the current instance on each mount; never persist login availability. */
export function useGitHubLogin() {
  const [enabled, setEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    githubLoginConfig(controller.signal)
      .then((config) => {
        if (!controller.signal.aborted) setEnabled(config.enabled);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEnabled(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, []);

  return { enabled, isLoading };
}
