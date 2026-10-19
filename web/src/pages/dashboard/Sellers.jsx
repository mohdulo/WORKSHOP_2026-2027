import { useState } from 'react';
import { api } from '../../lib/api.js';
import { centsToInput, formatAmount, formatDateTime, parseEuros } from '../../lib/format.js';
import { paymentErrorMessage } from '../../lib/messages.js';
import { useResource } from '../../lib/useResource.js';
import { ErrorNote, Id, Money, Spinner, StatusBadge } from '../../components/ui.jsx';

export default function Sellers({ secretKey }) {
  const list = useResource(async () => {
    const accounts = await api('/v1/accounts', { key: secretKey, query: { limit: 50 } });
    return Promise.all(
      accounts.data.map(async (a) => {
        const [balance, payouts] = await Promise.all([
          api(`/v1/accounts/${a.id}/balance`, { key: secretKey }),
          api('/v1/payouts', { key: secretKey, query: { account: a.id, limit: 5 } }),
        ]);
        return { ...a, balance: balance.available[0].amount, payouts: payouts.data };
      }),
    );
  }, [secretKey]);

  return (
    <div>
      <div className="panel-head">
        <h2 className="h-small">Vendeurs</h2>
        <button type="button" className="btn btn-quiet btn-small" onClick={list.reload} disabled={list.loading}>Actualiser</button>
      </div>
      <ErrorNote error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <div className="sellers">
          {list.data.map((s) => (
            <SellerCard
              key={s.id}
              seller={s}
              secretKey={secretKey}
              onChanged={() => {
                list.reload();
              }}
            />
          ))}
        </div>
      ) : (
        <p className="empty">Aucun vendeur.</p>
      )}
    </div>
  );
}

function SellerCard({ seller, secretKey, onChanged }) {
  const [value, setValue] = useState(seller.balance > 0 ? centsToInput(seller.balance) : '');
  const [state, setState] = useState({ busy: false, error: null, done: null });
  const cents = parseEuros(value);
  const invalid = cents === null || cents > seller.balance;

  async function payout(e) {
    e.preventDefault();
    if (invalid) return;
    setState({ busy: true, error: null, done: null });
    try {
      await api('/v1/payouts', { method: 'POST', key: secretKey, body: { account: seller.id, amount: cents } });
      setState({ busy: false, error: null, done: `Virement de ${formatAmount(cents)} envoyé.` });
      onChanged();
    } catch (err) {
      setState({ busy: false, error: paymentErrorMessage(err), done: null });
    }
  }

  return (
    <article className="seller" data-testid="seller">
      <header className="seller-head">
        <div>
          <h3 className="h-small">{seller.business_name || seller.email}</h3>
          <p className="small muted">{seller.email}</p>
        </div>
        <StatusBadge status={seller.status} />
      </header>
      <p className="seller-balance">
        <span className="small muted">Solde disponible</span>
        <Money cents={seller.balance} className={seller.balance < 0 ? 'negative' : ''} />
      </p>
      <p className="small"><Id value={seller.id} /></p>
      {state.done && <p className="note note-ok" role="status">{state.done}</p>}
      {state.error && <p className="note note-bad" role="alert">{state.error}</p>}
      {seller.balance > 0 ? (
        <form className="action-form" onSubmit={payout}>
          <label htmlFor={`po-${seller.id}`}>Virer vers le compte bancaire (€)</label>
          <div className="inline">
            <input id={`po-${seller.id}`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={invalid} />
            <button type="submit" className="btn btn-primary btn-small" disabled={state.busy || invalid}>Virer</button>
          </div>
        </form>
      ) : (
        <p className="small muted">{seller.balance < 0 ? 'Solde négatif après remboursement : il se renflouera avec les prochaines ventes.' : 'Rien à virer pour le moment.'}</p>
      )}
      {seller.payouts.length > 0 && (
        <div className="sub-list">
          <h4 className="h-tiny">Derniers virements</h4>
          <ul>
            {seller.payouts.map((p) => (
              <li key={p.id}><Money cents={p.amount} /> <span className="small muted">le {formatDateTime(p.created)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
