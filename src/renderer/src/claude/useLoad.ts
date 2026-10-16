import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/** Runs `load` on mount (unless `auto` is false) and on every `reload()`; ignores stale responses. */
export function useLoad<T>(load: () => Promise<T>, auto: boolean): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(auto);
  const [tick, setTick] = useState(auto ? 1 : 0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (tick === 0) return;
    let live = true;
    loadRef.current().then(
      (result) => {
        if (!live) return;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((t) => t + 1);
  }, []);
  return { data, error, loading, reload };
}
