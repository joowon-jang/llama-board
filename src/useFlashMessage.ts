import { useCallback, useEffect, useRef, useState } from "react";

export type ShowFlashMessage = (message: string | null) => void;

/**
 * A transient banner message that clears itself after `timeoutMs`. Passing
 * `null` to the setter (or calling `dismiss`) clears it immediately without
 * arming a new timer.
 */
export function useFlashMessage(timeoutMs = 4000): [string | null, ShowFlashMessage, () => void] {
  const [flash, setFlash] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const showFlash = useCallback<ShowFlashMessage>((message) => {
    clearTimer();
    setFlash(message);
    if (message) timerRef.current = window.setTimeout(() => setFlash(null), timeoutMs);
  }, [timeoutMs]);

  const dismissFlash = useCallback(() => {
    clearTimer();
    setFlash(null);
  }, []);

  useEffect(() => clearTimer, []);

  return [flash, showFlash, dismissFlash];
}
