import { useState } from 'react';
import { api } from '../../lib/api.js';
import { formatDate, formatDateTime, formatShortDate } from '../../lib/format.js';
import { paymentErrorMessage } from '../../lib/messages.js';
import { useResource } from '../../lib/useResource.js';
import { ErrorNote, Id, Money, Spinner, StatusBadge, Table } from '../../components/ui.jsx';

export default function Subscriptions({ secretKey }) {
  const list = useResource(async () => {
    const [subs, customers] = await Promise.all([
      api('/v1/subscriptions', { key: secretKey, query: { limit: 50 } }),
      api('/v1/customers', { key: secretKey, query: { limit: 100 } }),
    ]);
    const emails = Object.fromEntries(customers.data.map((c) => [c.id, c.email]));
    return subs.data.map((s) => ({ ...s, email: emails[s.customer] }));
  }, [secretKey]);
  const [selected, setSelected] = useState(null);

  const columns = [
    { key: 'email', label: 'Client', render: (s) => <span className="truncate">{s.email || s.customer}</span> },
    { key: 'status', label: 'Statut', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'period', label: 'Période en cours', render: (s) => (s.status === 'canceled' ? <span className="muted">Terminé</span> : `jusqu’au ${formatDate(s.current_period_end)}`) },
  ];

  return (
    <div className="split">
      <div className="split-main">
        <div className="panel-head">
          <h2 className="h-small">Abonnements</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={list.reload} disabled={list.loading}>Actualiser</button>
        </div>
        <ErrorNote error={list.error} onRetry={list.reload} />
        {list.loading && !list.data ? (
          <Spinner />
        ) : (
          <Table caption="Abonnements" columns={columns} rows={list.data} selectedId={selected} onRowClick={(s) => setSelected(s.id)} empty="Aucun abonnement. Souscrivez depuis la page Abonnement." />
        )}
      </div>
      {selected && (
        <SubscriptionDetail
          key={selected}
          id={selected}
          secretKey={secretKey}
          onClose={() => setSelected(null)}
          onChanged={() => {
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function SubscriptionDetail({ id, secretKey, onClose, onChanged }) {
  const detail = useResource(async () => {
    const [sub, invoices] = await Promise.all([
      api(`/v1/subscriptions/${id}`, { key: secretKey }),
      api('/v1/invoices', { key: secretKey, query: { subscription: id, limit: 50 } }),
    ]);
    return { sub, invoices: invoices.data };
  }, [id, secretKey]);
  const [action, setAction] = useState({ busy: false, error: null, done: null });

  if (detail.loading && !detail.data) return <aside className="detail"><Spinner /></aside>;
  if (detail.error && !detail.data) return <aside className="detail"><ErrorNote error={detail.error} onRetry={detail.reload} /></aside>;
  const { sub, invoices } = detail.data;

  async function run(label, fn) {
    setAction({ busy: true, error: null, done: null });
    try {
      await fn();
      setAction({ busy: false, error: null, done: label });
      detail.reload();
      onChanged();
    } catch (err) {
      setAction({ busy: false, error: paymentErrorMessage(err), done: null });
      detail.reload();
    }
  }

  const cancel = (atPeriodEnd) =>
    run(atPeriodEnd ? 'Résiliation programmée en fin de période.' : 'Abonnement résilié.', () =>
      api(`/v1/subscriptions/${sub.id}/cancel`, { method: 'POST', key: secretKey, body: { at_period_end: atPeriodEnd } }),
    );

  return (
    <aside className="detail" aria-labelledby="sub-title" data-testid="subscription-detail">
      <div className="detail-head">
        <div>
          <h3 id="sub-title" className="h-small">Abonnement</h3>
          <StatusBadge status={sub.status} />
          {sub.cancel_at_period_end && sub.status !== 'canceled' && <span className="small muted"> · se termine le {formatDate(sub.current_period_end)}</span>}
        </div>
        <button type="button" className="btn btn-quiet btn-small" onClick={onClose} aria-label="Fermer le détail">Fermer</button>
      </div>
      <dl className="kv">
        <div><dt>Identifiant</dt><dd><Id value={sub.id} /></dd></div>
        <div><dt>Client</dt><dd><Id value={sub.customer} /></dd></div>
        <div><dt>Période</dt><dd>{formatDate(sub.current_period_start)} → {formatDate(sub.current_period_end)}</dd></div>
        <div><dt>Créé le</dt><dd>{formatDateTime(sub.created)}</dd></div>
        {sub.canceled_at && <div><dt>Résilié le</dt><dd>{formatDateTime(sub.canceled_at)}</dd></div>}
      </dl>

      {action.done && <p className="note note-ok" role="status">{action.done}</p>}
      {action.error && <p className="note note-bad" role="alert">{action.error}</p>}

      {sub.status !== 'canceled' && (
        <div className="action-row">
          {!sub.cancel_at_period_end && sub.status !== 'incomplete' && (
            <button type="button" className="btn btn-ghost btn-small" disabled={action.busy} onClick={() => cancel(true)}>Résilier en fin de période</button>
          )}
          <button type="button" className="btn btn-danger btn-small" disabled={action.busy} onClick={() => cancel(false)}>Résilier maintenant</button>
        </div>
      )}

      <div className="sub-list">
        <h4 className="h-tiny">Factures</h4>
        <Table
          caption="Factures"
          columns={[
            {
              key: 'period',
              label: 'Période',
              render: (i) => (
                <span className="period">
                  <span>{formatShortDate(i.period_start)}</span> <span>→ {formatShortDate(i.period_end)}</span>
                </span>
              ),
            },
            { key: 'amount', label: 'Montant', align: 'right', render: (i) => <Money cents={i.amount_due} /> },
            { key: 'status', label: 'Statut', render: (i) => <StatusBadge status={i.status} /> },
            {
              key: 'act',
              label: 'Action',
              render: (i) =>
                i.status === 'open' && sub.status !== 'canceled' ? (
                  <button type="button" className="btn btn-quiet btn-small" disabled={action.busy} onClick={() => run('Facture payée.', () => api(`/v1/invoices/${i.id}/pay`, { method: 'POST', key: secretKey, body: {} }))}>
                    Relancer le paiement
                  </button>
                ) : i.attempt_count > 1 ? (
                  <span className="small muted">{i.attempt_count} tentatives</span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
          ]}
          rows={invoices}
          empty="Aucune facture (période d’essai)."
        />
      </div>
    </aside>
  );
}
