import { useCallback, useEffect, useRef } from 'react';

/**
 * Returns a stable getter for "is this component still mounted?".
 *
 * Used to guard `setState` in the tail of an async operation. A ref rather
 * than state, and a getter rather than the ref itself, so callers can hold it
 * in a `useCallback` dependency list without invalidating on every render.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return useCallback(() => mounted.current, []);
}
