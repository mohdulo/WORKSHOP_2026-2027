import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);

/** Charge GET /demo/config une fois (clé publique + catalogue). */
export function DemoConfigProvider({ children }) {
  const [state, setState] = useState({ loading: true, error: null, config: null });
  const load = useCallback(() => {
    setState({ loading: true, error: null, config: null });
    api('/demo/config')
      .then((config) => setState({ loading: false, error: null, config }))
      .catch((error) => setState({ loading: false, error, config: null }));
  }, []);
  useEffect(load, [load]);
  return <Ctx.Provider value={{ ...state, reload: load }}>{children}</Ctx.Provider>;
}

export const useDemoConfig = () => useContext(Ctx);
