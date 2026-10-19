import { useState } from 'react';
import { api } from '../lib/api.js';
import { useSecretKey } from '../lib/SecretKey.jsx';
import { formatLongDateTime } from '../lib/format.js';
import { useResource } from '../lib/useResource.js';
import Payments from './dashboard/Payments.jsx';
import Customers from './dashboard/Customers.jsx';
import Subscriptions from './dashboard/Subscriptions.jsx';
import Sellers from './dashboard/Sellers.jsx';
import Ledger from './dashboard/Ledger.jsx';
import Events from './dashboard/Events.jsx';
import TestClock from './dashboard/TestClock.jsx';

const TABS = [
  { id: 'payments', label: 'Paiements', Component: Payments },
  { id: 'customers', label: 'Clients', Component: Customers },
  { id: 'subscriptions', label: 'Abonnements', Component: Subscriptions },
  { id: 'sellers', label: 'Vendeurs', Component: Sellers },
  { id: 'ledger', label: 'Grand livre', Component: Ledger },
  { id: 'events', label: 'Événements', Component: Events },
  { id: 'clock', label: 'Horloge de test', Component: TestClock },
];

export default function Dashboard() {
  const { secretKey, setSecretKey } = useSecretKey();
  if (!secretKey) return <KeyGate onKey={setSecretKey} />;
  return <Console secretKey={secretKey} onLock={() => setSecretKey(null)} />;
}

function KeyGate({ onKey }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const key = value.trim();
    if (!/^sk_test_[0-9A-Za-z]{16,}$/.test(key)) {
      setError(key.startsWith('pk_') ? 'C’est la clé publique : le tableau de bord demande la clé secrète (sk_test_…).' : 'Format attendu : sk_test_ suivi d’au moins 16 caractères.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/v1/ledger/check', { key }); // vérifie que la clé est valide ET secrète
      setValue('');
      onKey(key);
    } catch (err) {
      setError(err.status === 401 ? 'Clé inconnue : vérifiez la variable SECRET_KEY du serveur.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>Tableau de bord</h1>
        <p className="muted">
          Saisissez la clé secrète du compte PaySim. Elle reste dans la mémoire de cet onglet : recharger la page l’efface.
        </p>
        <div className="field">
          <label htmlFor="sk">Clé secrète</label>
          <input
            id="sk"
            type="password"
            autoComplete="off"
            spellCheck="false"
            placeholder="sk_test_…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'sk-err' : 'sk-help'}
          />
          {error ? (
            <p id="sk-err" className="field-error">{error}</p>
          ) : (
            <p id="sk-help" className="small muted">En développement, c’est la valeur de SECRET_KEY (par défaut dans server/src/config.js).</p>
          )}
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !value}>
          {busy ? 'Vérification…' : 'Ouvrir le tableau de bord'}
        </button>
      </form>
    </main>
  );
}

function Console({ secretKey, onLock }) {
  const [tab, setTab] = useState('payments');
  // Un seul onglet est monté à la fois : il recharge ses données en s'affichant. Après une action, l'onglet
  // recharge LUI-MÊME ce qui a changé (pas de remontage via `key`, qui effacerait son état : détail ouvert,
  // message de confirmation — taskForLesson L19). L'horloge, partagée avec l'en-tête, est rechargée ici.
  const clock = useResource(() => api('/v1/test_clock', { key: secretKey }), [secretKey]);
  const active = TABS.find((t) => t.id === tab);

  function onTabKey(e) {
    const i = TABS.findIndex((t) => t.id === tab);
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    if (j === null) return;
    e.preventDefault();
    setTab(TABS[j].id);
    document.getElementById(`tab-${TABS[j].id}`)?.focus();
  }

  return (
    <main className="page dashboard">
      <header className="dash-head">
        <div>
          <h1>Tableau de bord</h1>
          <p className="dash-clock" aria-live="polite">
            Date simulée : <strong data-testid="sim-date">{clock.data ? formatLongDateTime(clock.data.now) : '…'}</strong>
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={onLock}>
          Oublier la clé
        </button>
      </header>

      <div className="tabs" role="tablist" aria-label="Sections du tableau de bord" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section id={`panel-${active.id}`} role="tabpanel" aria-labelledby={`tab-${active.id}`} className="panel">
        <active.Component secretKey={secretKey} clock={clock} onClockChanged={clock.reload} />
      </section>
    </main>
  );
}
