import { useEffect, useState } from "react";

export function useTimeTick(intervalMs = 15_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
