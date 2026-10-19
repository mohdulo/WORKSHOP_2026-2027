import { useState } from 'react';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useResource } from '../../lib/useResource.js';
import { ErrorNote, Id, Spinner, StatusBadge, Table } from '../../components/ui.jsx';

export default function Events({ secretKey }) {
  const [type, setType] = useState('');
  const events = useResource(() => api('/v1/events', { key: secretKey, query: { limit: 50, type: type || undefined } }), [secretKey, type]);
  const endpoints = useResource(async () => {
    const list = await api('/v1/webhook_endpoints', { key: secretKey, query: { limit: 20 } });
    return Promise.all(list.data.map(async (e) => ({ ...e, deliveries: (await api(`/v1/webhook_endpoints/${e.id}/deliveries`, { key: secretKey, query: { limit: 20 } })).data })));
  }, [secretKey]);
  const [open, setOpen] = useState(null);

  return (
    <div className="stack">
      <div>
        <div className="panel-head">
          <h2 className="h-small">Événements</h2>
          <div className="inline">
            <label htmlFor="evt-type" className="visually-hidden">Filtrer par type</label>
            <select id="evt-type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Tous les types</option>
              {['payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.refunded', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.created', 'payout.paid'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button type="button" className="btn btn-quiet btn-small" onClick={events.reload} disabled={events.loading}>Actualiser</button>
          </div>
        </div>
        <ErrorNote error={events.error} onRetry={events.reload} />
        {events.loading && !events.data ? (
          <Spinner />
        ) : (
          <Table
            caption="Événements"
            columns={[
              { key: 'type', label: 'Type', render: (e) => <code className="evt-type">{e.type}</code> },
              { key: 'obj', label: 'Objet', render: (e) => <Id value={e.data.object.id} /> },
              { key: 'created', label: 'Date', render: (e) => formatDateTime(e.created) },
            ]}
            rows={events.data?.data}
            selectedId={open}
            onRowClick={(e) => setOpen(open === e.id ? null : e.id)}
            empty="Aucun événement pour ce filtre."
          />
        )}
        {open && events.data?.data.find((e) => e.id === open) && (
          <pre className="json" aria-label="Contenu de l’événement">{JSON.stringify(events.data.data.find((e) => e.id === open), null, 2)}</pre>
        )}
      </div>

      <div>
        <div className="panel-head">
          <h2 className="h-small">Livraisons webhook</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={endpoints.reload} disabled={endpoints.loading}>Actualiser</button>
        </div>
        <ErrorNote error={endpoints.error} onRetry={endpoints.reload} />
        {endpoints.loading && !endpoints.data ? (
          <Spinner />
        ) : endpoints.data?.length ? (
          endpoints.data.map((ep) => (
            <div key={ep.id} className="endpoint">
              <p className="endpoint-url">
                <span className="truncate">{ep.url}</span> <StatusBadge status={ep.status} />
              </p>
              <Table
                caption={`Livraisons vers ${ep.url}`}
                columns={[
                  { key: 'event_type', label: 'Événement', render: (d) => <code className="evt-type">{d.event_type}</code> },
                  { key: 'status', label: 'Statut', render: (d) => <StatusBadge status={d.status} /> },
                  { key: 'attempts', label: 'Tentatives', align: 'right' },
                  { key: 'last', label: 'Dernier résultat', render: (d) => d.last_error || (d.last_status_code ? `HTTP ${d.last_status_code}` : '—') },
                ]}
                rows={ep.deliveries}
                empty="Aucune livraison pour cette adresse."
              />
            </div>
          ))
        ) : (
          <p className="empty">
            Aucune adresse de webhook. Créez-en une avec <code>POST /v1/webhook_endpoints</code> pour suivre ici les envois signés.
          </p>
        )}
      </div>
    </div>
  );
}
