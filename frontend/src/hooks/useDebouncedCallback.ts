import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Returns a stable debounced version of the given callback.
 * The debounced function delays invocation until `delayMs` milliseconds
 * have elapsed since the last call. The pending timer is automatically
 * cancelled when the component unmounts.
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  callback: T,
  delayMs: number,
): T & { cancel: () => void } {
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always point at the latest callback without re-creating the debounced fn
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cancel on unmount
  useEffect(() => cancel, [cancel]);

  const debounced = useMemo(() => {
    const fn = (...args: unknown[]) => {
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        callbackRef.current(...args);
      }, delayMs);
    };
    fn.cancel = cancel;
    return fn as T & { cancel: () => void };
  }, [delayMs, cancel]);

  return debounced;
}
