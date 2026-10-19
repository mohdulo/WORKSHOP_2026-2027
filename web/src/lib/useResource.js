import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useResource(loader, deps) → { data, error, loading, reload }
 * Ignore les réponses arrivées après un changement de deps (pas de course entre deux chargements).
 */
export function useResource(loader, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(run)
      .then((data) => n === seq.current && setState({ data, error: null, loading: false }))
      .catch((error) => n === seq.current && setState((s) => ({ data: s.data, error, loading: false })));
  }, [run]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}
