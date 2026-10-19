import { api } from '../../lib/api.js';
import { formatAmount } from '../../lib/format.js';
import { useResource } from '../../lib/useResource.js';
import { ErrorNote, Money, Spinner, Table } from '../../components/ui.jsx';

const ACCOUNT_LABELS = {
  network_receivable: 'Créance sur le réseau carte',
  platform_balance: 'Solde de la plateforme',
  psp_revenue: 'Frais PaySim perçus',
  bank_payouts: 'Virements aux vendeurs',
};
const TYPE_LABELS = { asset: 'Actif', liability: 'Passif', revenue: 'Produit' };

export default function Ledger({ secretKey }) {
  const data = useResource(async () => {
    const [check, accounts, sellers] = await Promise.all([
      api('/v1/ledger/check', { key: secretKey }),
      api('/v1/ledger/accounts', { key: secretKey }),
      api('/v1/accounts', { key: secretKey, query: { limit: 100 } }),
    ]);
    const names = Object.fromEntries(sellers.data.map((s) => [`merchant:${s.id}`, s.business_name || s.email]));
    return { check, accounts: accounts.data.map((a) => ({ ...a, label: ACCOUNT_LABELS[a.code] || (names[a.code] ? `Vendeur : ${names[a.code]}` : a.code) })) };
  }, [secretKey]);

  const debit = data.data?.accounts.reduce((s, a) => s + (a.net > 0 ? a.net : 0), 0) ?? 0;

  return (
    <div>
      <div className="panel-head">
        <h2 className="h-small">Grand livre</h2>
        <button type="button" className="btn btn-quiet btn-small" onClick={data.reload} disabled={data.loading}>Actualiser</button>
      </div>
      <ErrorNote error={data.error} onRetry={data.reload} />
      {data.loading && !data.data ? (
        <Spinner />
      ) : data.data ? (
        <>
          <div className={`ledger-status ${data.data.check.balanced ? 'is-ok' : 'is-bad'}`} data-testid="ledger-status" role="status">
            <span className="ledger-mark" aria-hidden="true" />
            <div>
              <p className="ledger-title">{data.data.check.balanced ? 'Équilibré' : 'Déséquilibré'}</p>
              <p className="small">
                {data.data.check.balanced
                  ? `Débits et crédits s’annulent : ${formatAmount(debit)} de chaque côté, sur ${data.data.check.entries} écritures.`
                  : `Écart de ${formatAmount(data.data.check.total)} ; ${data.data.check.unbalanced_transactions.length} transaction(s) en cause.`}
              </p>
            </div>
          </div>
          <Table
            caption="Comptes du grand livre"
            columns={[
              { key: 'label', label: 'Compte', render: (a) => <span>{a.label}<span className="small muted block wrap-anywhere">{a.code}</span></span> },
              { key: 'type', label: 'Nature', render: (a) => TYPE_LABELS[a.type] || a.type },
              { key: 'entries', label: 'Écritures', align: 'right' },
              { key: 'balance', label: 'Solde', align: 'right', render: (a) => <Money cents={a.balance} className={a.balance < 0 ? 'negative' : ''} /> },
            ]}
            rows={data.data.accounts}
          />
          <p className="small muted footnote">
            Partie double : chaque opération débite et crédite des comptes pour le même total. Les soldes de passif et de produit sont affichés en positif.
          </p>
        </>
      ) : null}
    </div>
  );
}
