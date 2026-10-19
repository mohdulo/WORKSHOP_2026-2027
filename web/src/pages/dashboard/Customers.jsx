import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useResource } from '../../lib/useResource.js';
import { ErrorNote, Id, Spinner, Table } from '../../components/ui.jsx';

export default function Customers({ secretKey }) {
  const list = useResource(() => api('/v1/customers', { key: secretKey, query: { limit: 50 } }), [secretKey]);
  const columns = [
    { key: 'email', label: 'E-mail', render: (c) => <span className="truncate">{c.email}</span> },
    { key: 'id', label: 'Identifiant', render: (c) => <Id value={c.id} /> },
    { key: 'pm', label: 'Carte par défaut', render: (c) => (c.invoice_settings.default_payment_method ? <Id value={c.invoice_settings.default_payment_method} /> : <span className="muted">Aucune</span>) },
    { key: 'created', label: 'Créé le', render: (c) => formatDateTime(c.created) },
  ];
  return (
    <div>
      <div className="panel-head">
        <h2 className="h-small">Clients</h2>
        <button type="button" className="btn btn-quiet btn-small" onClick={list.reload} disabled={list.loading}>Actualiser</button>
      </div>
      <ErrorNote error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Spinner /> : <Table caption="Clients" columns={columns} rows={list.data?.data} empty="Aucun client. Un abonnement crée un client." />}
    </div>
  );
}
