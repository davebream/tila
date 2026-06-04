import { useCallback, useEffect, useRef, useState } from "react";

export function useTableKeyNav(
  rowCount: number,
  onSelect?: (index: number) => void,
) {
  const [focusIdx, setFocusIdx] = useState(-1);
  const focusIdxRef = useRef(focusIdx);
  focusIdxRef.current = focusIdx;

  useEffect(() => {
    if (focusIdx >= rowCount) setFocusIdx(Math.max(rowCount - 1, -1));
  }, [rowCount, focusIdx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (rowCount === 0) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(i + 1, rowCount - 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && focusIdxRef.current >= 0 && onSelect) {
        e.preventDefault();
        onSelect(focusIdxRef.current);
      }
    },
    [rowCount, onSelect],
  );

  return { focusIdx, handleKeyDown };
}
