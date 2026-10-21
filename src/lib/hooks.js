import { useCallback, useEffect, useRef, useState } from "../../vendor/preact-htm.js";
import { api } from "./api.js";

/** Load data from the API; `reload()` refetches; `poll` (ms) keeps refetching while `shouldPoll(data)` is true. */
export function useApi(path, opts = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const timer = useRef(null);

  const load = useCallback(async () => {
    if (!path) return undefined;
    try {
      const d = await api(path);
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError(e?.message ?? "Something went wrong.");
      return undefined;
    }
  }, [path]);

  const loop = useCallback(async () => {
    clearTimeout(timer.current);
    const d = await load();
    const { poll, shouldPoll } = optsRef.current;
    if (poll && d && shouldPoll?.(d)) timer.current = setTimeout(loop, poll);
    return d;
  }, [load]);

  useEffect(() => {
    setData(null);
    setError(null);
    loop();
    return () => clearTimeout(timer.current);
  }, [loop]);

  const loading = data === null && error === null;
  return { data, error, loading, reload: loop, setData };
}

/** Sets document.title for the current page. */
export function useTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} — TestYourBrain` : "TestYourBrain";
  }, [title]);
}
