import { useState } from 'react';
import { api } from '../../lib/api.js';
import { formatLongDateTime } from '../../lib/format.js';
import { ErrorNote, Spinner } from '../../components/ui.jsx';

const DAY = 86400;

/** Avance d'un mois CALENDAIRE (même jour du mois suivant, écrêté au dernier jour) : comme la facturation serveur. */
function secondsToNextMonth(nowTs) {
  const d = new Date(nowTs * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const target = Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return Math.round(target / 1000) - nowTs;
}

export default function TestClock({ secretKey, onClockChanged, clock }) {
  const [state, setState] = useState({ busy: false, error: null, last: null });

  async function advance(label, seconds) {
    setState({ busy: true, error: null, last: null });
    try {
      const r = await api('/v1/test_clock/advance', { method: 'POST', key: secretKey, body: { seconds } });
      setState({ busy: false, error: null, last: { label, ...r } });
      onClockChanged();
    } catch (err) {
      setState({ busy: false, error: err, last: null });
    }
  }

  const now = clock.data?.now;
  const steps = [
    { label: '+1 jour', seconds: () => DAY },
    { label: '+7 jours', seconds: () => 7 * DAY },
    { label: '+1 mois', seconds: () => secondsToNextMonth(now) },
  ];

  return (
    <div className="clock">
      <h2 className="h-small">Horloge de test</h2>
      <p className="muted">
        Faites avancer le temps pour déclencher les échéances : facturation des abonnements, relances après un refus, expiration des autorisations non capturées, envoi des webhooks.
      </p>
      {clock.loading && !clock.data ? (
        <Spinner />
      ) : clock.error ? (
        <ErrorNote error={clock.error} onRetry={clock.reload} />
      ) : (
        <p className="clock-now" data-testid="clock-now">{formatLongDateTime(now)}</p>
      )}
      <div className="action-row">
        {steps.map((s) => (
          <button key={s.label} type="button" className="btn btn-ghost" disabled={state.busy || !now} onClick={() => advance(s.label, s.seconds())}>
            {s.label}
          </button>
        ))}
      </div>
      {state.busy && <Spinner label="Traitement des échéances…" />}
      <ErrorNote error={state.error} />
      {state.last && <ClockResult result={state.last} />}
    </div>
  );
}

function ClockResult({ result }) {
  const b = result.results.billing;
  const lines = [
    [b.invoices_created.length, 'facture émise', 'factures émises'],
    [b.invoices_paid.length, 'facture payée', 'factures payées'],
    [b.payment_failures.length, 'paiement refusé', 'paiements refusés'],
    [b.subscriptions_canceled.length, 'abonnement résilié', 'abonnements résiliés'],
    [result.results.expired_authorizations.length, 'autorisation expirée', 'autorisations expirées'],
  ].filter(([n]) => n > 0);
  return (
    <div className="note note-ok" role="status" data-testid="clock-result">
      <p className="note-title">Horloge avancée ({result.label}) au {formatLongDateTime(result.now)}</p>
      {lines.length ? (
        <ul className="plain">
          {lines.map(([n, one, many]) => (
            <li key={one}>{n} {n > 1 ? many : one}</li>
          ))}
        </ul>
      ) : (
        <p>Aucune échéance sur cette période.</p>
      )}
    </div>
  );
}
