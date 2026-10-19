// Client HTTP de l'API PaySim. Aucune donnée de carte n'est journalisée ni conservée ici.

export class ApiError extends Error {
  constructor(status, error = {}) {
    super(error.message || `Erreur HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.type = error.type;
    this.code = error.code;
    this.declineCode = error.decline_code;
    this.param = error.param;
    this.detail = error;
  }
}

/** Clé d'idempotence (crypto.randomUUID n'existe qu'en contexte sécurisé : repli sur getRandomValues). */
export function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * api(path, { method, key, body, query })
 * - key : clé API (pk ou sk) envoyée en Bearer ; absente pour /demo.
 * - Chaque POST porte une Idempotency-Key neuve (un double-clic réseau rejoué ne double pas l'opération).
 */
export async function api(path, { method = 'GET', key, body, query } = {}) {
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && path.startsWith('/v1/')) headers['Idempotency-Key'] = idempotencyKey();

  let url = path;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if ([...qs].length) url += `?${qs}`;
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, { type: 'network_error', code: 'network_error', message: 'Serveur PaySim injoignable. Vérifiez qu’il est démarré.' });
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, { type: 'api_error', code: 'invalid_response', message: `Réponse inattendue du serveur (HTTP ${res.status}).` });
    }
  }
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

/** Récupère toutes les pages d'une liste (plafonné) : { object: 'list', data, has_more }. */
export async function listAll(path, { key, query, max = 300 } = {}) {
  const out = [];
  let startingAfter;
  for (;;) {
    const page = await api(path, { key, query: { ...query, limit: 100, starting_after: startingAfter } });
    out.push(...page.data);
    if (!page.has_more || out.length >= max || page.data.length === 0) return { data: out, truncated: page.has_more };
    startingAfter = page.data[page.data.length - 1].id;
  }
}
