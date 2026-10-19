import { createContext, useContext, useState } from 'react';

/**
 * Clé secrète du tableau de bord : gardée UNIQUEMENT en mémoire (état React).
 * Jamais dans localStorage, sessionStorage, un cookie ou l'URL : un rechargement de page l'oublie.
 * Placée au niveau de l'App pour survivre à la navigation entre pages.
 */
const Ctx = createContext(null);

export function SecretKeyProvider({ children }) {
  const [secretKey, setSecretKey] = useState(null);
  return <Ctx.Provider value={{ secretKey, setSecretKey }}>{children}</Ctx.Provider>;
}

export const useSecretKey = () => useContext(Ctx);
