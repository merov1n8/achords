import { useEffect, useState } from "preact/hooks";

/** Loads `fn` now and every `ms`; returns the latest value and error. Simple and robust. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () =>
      fn()
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(undefined);
        })
        .catch((e: Error) => alive && setError(e.message));
    run();
    const id = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [...deps, tick]);
  return { data, error, refresh: () => setTick((t) => t + 1) };
}
