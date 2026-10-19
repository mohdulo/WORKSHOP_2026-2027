import { useState } from 'react';
import { api } from '../../lib/api.js';
import { centsToInput, formatAmount, formatDateTime, parseEuros, BRAND_LABELS } from '../../lib/format.js';
import { paymentErrorMessage } from '../../lib/messages.js';
import { useResource } from '../../lib/useResource.js';
import { ErrorNote, Id, Money, Spinner, StatusBadge, Table } from '../../components/ui.jsx';

export default function Payments({ secretKey }) {
  const list = useResource(() => api('/v1/payment_intents', { key: secretKey, query: { limit: 50 } }), [secretKey]);
  const [selected, setSelected] = useState(null);

  const columns = [
    { key: 'amount', label: 'Montant', align: 'right', render: (pi) => <Money cents={pi.amount} /> },
    { key: 'status', label: 'Statut', render: (pi) => <StatusBadge status={pi.status} /> },
    { key: 'description', label: 'Description', render: (pi) => <span className="truncate">{pi.description || <span className="muted">—</span>}</span> },
    { key: 'created', label: 'Date', render: (pi) => formatDateTime(pi.created) },
  ];

  return (
    <div className="split">
      <div className="split-main">
        <div className="panel-head">
          <h2 className="h-small">Paiements</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={list.reload} disabled={list.loading}>
            Actualiser
          </button>
        </div>
        <ErrorNote error={list.error} onRetry={list.reload} />
        {list.loading && !list.data ? (
          <Spinner />
        ) : (
          <Table
            caption="Paiements"
            columns={columns}
            rows={list.data?.data}
            selectedId={selected}
            onRowClick={(pi) => setSelected(pi.id)}
            empty="Aucun paiement. Faites un achat dans la boutique pour en voir un ici."
          />
        )}
      </div>
      {selected && (
        <PaymentDetail
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

function PaymentDetail({ id, secretKey, onClose, onChanged }) {
  const detail = useResource(async () => {
    const pi = await api(`/v1/payment_intents/${id}`, { key: secretKey });
    const [charges, refunds] = await Promise.all([
      api('/v1/charges', { key: secretKey, query: { payment_intent: id, limit: 20 } }),
      api('/v1/refunds', { key: secretKey, query: { payment_intent: id, limit: 50 } }),
    ]);
    return { pi, charges: charges.data, refunds: refunds.data };
  }, [id, secretKey]);
  const [action, setAction] = useState({ busy: false, error: null, done: null });

  if (detail.loading && !detail.data) return <aside className="detail"><Spinner /></aside>;
  if (detail.error && !detail.data) return <aside className="detail"><ErrorNote error={detail.error} onRetry={detail.reload} /></aside>;
  const { pi, charges, refunds } = detail.data;
  const charge = charges.find((c) => c.id === pi.latest_charge) || charges[0];
  const refunded = refunds.reduce((s, r) => s + r.amount, 0);
  const refundable = pi.status === 'succeeded' ? pi.amount_received - refunded : 0;

  async function run(label, fn) {
    setAction({ busy: true, error: null, done: null });
    try {
      await fn();
      setAction({ busy: false, error: null, done: label });
      detail.reload();
      onChanged();
    } catch (err) {
      setAction({ busy: false, error: paymentErrorMessage(err), done: null });
    }
  }

  return (
    <aside className="detail" aria-labelledby="pi-title" data-testid="payment-detail">
      <div className="detail-head">
        <div>
          <h3 id="pi-title" className="detail-amount"><Money cents={pi.amount} /></h3>
          <StatusBadge status={pi.status} />
        </div>
        <button type="button" className="btn btn-quiet btn-small" onClick={onClose} aria-label="Fermer le détail">
          Fermer
        </button>
      </div>
      <dl className="kv">
        <div><dt>Identifiant</dt><dd><Id value={pi.id} /></dd></div>
        <div><dt>Description</dt><dd>{pi.description || '—'}</dd></div>
        <div><dt>Créé le</dt><dd>{formatDateTime(pi.created)}</dd></div>
        {charge && (
          <div>
            <dt>Carte</dt>
            <dd>
              {BRAND_LABELS[charge.payment_method_details.card.brand] || charge.payment_method_details.card.brand} •••• {charge.payment_method_details.card.last4}
              {charge.payment_method_details.card.three_d_secure ? ' · 3-D Secure' : ''}
            </dd>
          </div>
        )}
        <div><dt>Encaissé</dt><dd><Money cents={pi.amount_received} /></dd></div>
        {pi.status === 'requires_capture' && <div><dt>À capturer</dt><dd><Money cents={pi.amount_capturable} /></dd></div>}
        <div><dt>Remboursé</dt><dd><Money cents={refunded} /></dd></div>
        {pi.transfer_data && (
          <>
            <div><dt>Vendeur</dt><dd><Id value={pi.transfer_data.destination} /></dd></div>
            <div><dt>Commission</dt><dd><Money cents={pi.application_fee_amount} /></dd></div>
          </>
        )}
        {pi.customer && <div><dt>Client</dt><dd><Id value={pi.customer} /></dd></div>}
        {pi.last_payment_error && <div><dt>Dernier refus</dt><dd>{paymentErrorMessage(pi.last_payment_error)}</dd></div>}
      </dl>

      {action.done && <p className="note note-ok" role="status">{action.done}</p>}
      {action.error && <p className="note note-bad" role="alert">{action.error}</p>}

      {pi.status === 'requires_capture' && (
        <CaptureForm max={pi.amount_capturable} busy={action.busy} onCapture={(amount) => run('Paiement capturé.', () => api(`/v1/payment_intents/${pi.id}/capture`, { method: 'POST', key: secretKey, body: { amount_to_capture: amount } }))} onCancel={() => run('Autorisation annulée.', () => api(`/v1/payment_intents/${pi.id}/cancel`, { method: 'POST', key: secretKey, body: {} }))} />
      )}

      {refundable > 0 && (
        <RefundForm
          max={refundable}
          marketplace={Boolean(pi.transfer_data)}
          busy={action.busy}
          onRefund={(amount, refundFee) =>
            run(`Remboursement de ${formatAmount(amount)} effectué.`, () =>
              api('/v1/refunds', { method: 'POST', key: secretKey, body: { payment_intent: pi.id, amount, reason: 'requested_by_customer', ...(refundFee ? { refund_application_fee: true } : {}) } }),
            )
          }
        />
      )}
      {pi.status === 'succeeded' && refundable === 0 && <p className="small muted">Ce paiement est intégralement remboursé.</p>}

      {refunds.length > 0 && (
        <div className="sub-list">
          <h4 className="h-tiny">Remboursements</h4>
          <ul>
            {refunds.map((r) => (
              <li key={r.id}>
                <Money cents={r.amount} /> <span className="muted small">le {formatDateTime(r.created)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function CaptureForm({ max, busy, onCapture, onCancel }) {
  const [value, setValue] = useState(centsToInput(max));
  const cents = parseEuros(value);
  const invalid = cents === null || cents > max;
  return (
    <form className="action-form" onSubmit={(e) => (e.preventDefault(), !invalid && onCapture(cents))}>
      <label htmlFor="cap-amount">Montant à capturer (€)</label>
      <div className="inline">
        <input id="cap-amount" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={invalid} />
        <button type="submit" className="btn btn-primary btn-small" disabled={busy || invalid}>Capturer</button>
      </div>
      <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={onCancel}>Annuler l’autorisation</button>
    </form>
  );
}

function RefundForm({ max, marketplace, busy, onRefund }) {
  const [value, setValue] = useState(centsToInput(max));
  const [refundFee, setRefundFee] = useState(true);
  const cents = parseEuros(value);
  const invalid = cents === null || cents > max;
  return (
    <form className="action-form" onSubmit={(e) => (e.preventDefault(), !invalid && onRefund(cents, marketplace && refundFee))}>
      <label htmlFor="refund-amount">Montant à rembourser (€)</label>
      <div className="inline">
        <input id="refund-amount" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={invalid} aria-describedby="refund-help" />
        <button type="submit" className="btn btn-primary btn-small" disabled={busy || invalid}>
          {cents === max ? 'Rembourser tout' : 'Rembourser'}
        </button>
      </div>
      <p id="refund-help" className={`small ${invalid ? 'field-error' : 'muted'}`}>
        {invalid ? `Saisissez un montant entre 0,01 € et ${formatAmount(max)}.` : `Jusqu’à ${formatAmount(max)} remboursables.`}
      </p>
      {marketplace && (
        <label className="check-label">
          <input type="checkbox" checked={refundFee} onChange={(e) => setRefundFee(e.target.checked)} />
          Rendre au vendeur la part de commission correspondante
        </label>
      )}
    </form>
  );
}
