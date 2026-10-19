import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useDemoConfig } from '../lib/DemoConfig.jsx';
import { BRAND_LABELS, formatAmount, formatDate } from '../lib/format.js';
import { paymentErrorMessage } from '../lib/messages.js';
import { CardForm } from '../components/CardForm.jsx';
import { TestCards } from '../components/TestCards.jsx';
import { ErrorNote, Money, Spinner, StatusBadge } from '../components/ui.jsx';

/**
 * Abonnement : carte tokenisée chez PaySim (pk) → POST /demo/subscribe { email, payment_method }.
 * Le prélèvement est « hors session » : une carte 3-D Secure est refusée (authentication_required).
 */
export default function Subscribe() {
  const { config, loading, error, reload } = useDemoConfig();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState(null);
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);
  const formRef = useRef(null);
  const emailRef = useRef(null);

  if (loading) return <main className="page"><Spinner label="Chargement de l’offre…" /></main>;
  if (error) return <main className="page"><ErrorNote error={error} onRetry={reload} /></main>;

  const price = config.subscriptionPrice;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function onTokenized(pm) {
    setFailure(null);
    try {
      const res = await api('/demo/subscribe', { method: 'POST', body: { email: email.trim(), payment_method: pm.id, priceId: price.id } });
      setDone({ ...res, card: pm.card });
    } catch (err) {
      setFailure(paymentErrorMessage(err));
    }
  }

  if (done) {
    return (
      <main className="page receipt-page">
        <div className="receipt" data-testid="subscription-result">
          <p className="receipt-status">
            <span className="check" aria-hidden="true" />
            Abonnement activé
          </p>
          <p className="receipt-amount"><Money cents={done.invoice.amount_paid} /></p>
          <p className="receipt-sub">
            premier mois de <strong>{price.name}</strong> payé
          </p>
          <dl className="receipt-lines">
            <div>
              <dt>Statut</dt>
              <dd><StatusBadge status={done.subscription.status} /></dd>
            </div>
            <div>
              <dt>Prochain prélèvement</dt>
              <dd>{formatDate(done.subscription.current_period_end)}</dd>
            </div>
            <div>
              <dt>Carte</dt>
              <dd>{BRAND_LABELS[done.card.brand] || done.card.brand} •••• {done.card.last4}</dd>
            </div>
            <div>
              <dt>Référence</dt>
              <dd><code className="id">{done.subscription.id}</code></dd>
            </div>
          </dl>
          <div className="receipt-actions">
            <Link className="btn btn-primary" to="/dashboard">Suivre dans le tableau de bord</Link>
            <Link className="btn btn-ghost" to="/checkout">Retour à la boutique</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="page subscribe">
      <header className="page-head">
        <p className="shop-name">{config.shop}</p>
        <h1>{price.name}</h1>
        <p className="lede">{price.description}</p>
      </header>
      <div className="checkout-grid">
        <section className="plan" aria-labelledby="plan-title">
          <h2 id="plan-title" className="visually-hidden">Formule</h2>
          <p className="plan-price">
            <Money cents={price.unit_amount} />
            <span className="plan-per">par mois</span>
          </p>
          <ul className="plan-points">
            <li>Prélevé aujourd’hui, puis le même jour chaque mois.</li>
            <li>Résiliable à tout moment depuis le tableau de bord.</li>
            <li>En cas de refus, trois nouvelles tentatives sur cinq jours avant résiliation.</li>
          </ul>
        </section>
        <section className="pay-panel" aria-labelledby="sub-pay-title">
          <h2 id="sub-pay-title" className="h-small">Vos informations</h2>
          <div className="field">
            <label htmlFor="sub-email">Adresse e-mail</label>
            <input
              id="sub-email"
              ref={emailRef}
              type="email"
              autoComplete="email"
              placeholder="vous@exemple.fr"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
              }}
              onBlur={() => email && !emailOk && setEmailError('Adresse e-mail invalide.')}
              aria-invalid={Boolean(emailError)}
              aria-describedby={emailError ? 'sub-email-err' : undefined}
            />
            {emailError && <p id="sub-email-err" className="field-error">{emailError}</p>}
          </div>
          {failure && (
            <div className="note note-bad" role="alert" data-testid="payment-error">
              <p className="note-title">Abonnement non activé</p>
              <p>{failure}</p>
            </div>
          )}
          <CardForm
            ref={formRef}
            publishableKey={config.publishableKey}
            submitLabel={`S’abonner pour ${formatAmount(price.unit_amount)} / mois`}
            disabled={!emailOk}
            onTokenized={onTokenized}
          />
          {!emailOk && <p className="small muted">Saisissez votre e-mail pour activer le paiement.</p>}
          <TestCards
            onPick={(n) => formRef.current?.prefill(n)}
            subset={['4242424242424242', '4000000000000002', '4000000000000341', '4000000000003220']}
          />
        </section>
      </div>
    </main>
  );
}
