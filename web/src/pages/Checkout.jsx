import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useDemoConfig } from '../lib/DemoConfig.jsx';
import { BRAND_LABELS, formatAmount, formatLongDateTime } from '../lib/format.js';
import { paymentErrorMessage } from '../lib/messages.js';
import { CardForm } from '../components/CardForm.jsx';
import { TestCards } from '../components/TestCards.jsx';
import { ThreeDsModal } from '../components/ThreeDsModal.jsx';
import { ErrorNote, Money, Spinner } from '../components/ui.jsx';

/**
 * Parcours d'achat :
 *  1. POST /demo/checkout { productId }       → backend marchand : PI au prix du catalogue, renvoie client_secret
 *  2. POST /v1/payment_methods (pk)           → carte tokenisée directement chez PaySim (CardForm)
 *  3. POST /v1/payment_intents/:id/confirm    → pk + client_secret
 *  4. si requires_action : fenêtre 3-D Secure → POST /v1/three_ds/:id/complete (pk + client_secret)
 *  5. écran de résultat
 * Le PI est créé au moment de payer (pas à la sélection) : changer de produit ne laisse pas de PI orphelin.
 * Après un refus, le même PI est réutilisé (il est revenu à requires_payment_method).
 */
export default function Checkout() {
  const { config, loading, error, reload } = useDemoConfig();
  const [selectedId, setSelectedId] = useState(null);
  const [intent, setIntent] = useState(null); // { id, client_secret, amount, productId }
  const [threeDs, setThreeDs] = useState(null); // { challengeId, card }
  const [deciding, setDeciding] = useState(false);
  const [failure, setFailure] = useState(null);
  const [result, setResult] = useState(null);
  const formRef = useRef(null);

  if (loading) return <main className="page"><Spinner label="Chargement de la boutique…" /></main>;
  if (error) return <main className="page"><ErrorNote error={error} onRetry={reload} /></main>;

  const products = config.products;
  const product = products.find((p) => p.id === selectedId) || products[0];
  const pk = config.publishableKey;

  function choose(id) {
    if (id === product.id) return;
    setSelectedId(id);
    setIntent(null); // un nouveau PI sera créé au prochain paiement, au prix du nouveau produit
    setFailure(null);
  }

  async function ensureIntent() {
    if (intent && intent.productId === product.id) return intent;
    const pi = await api('/demo/checkout', { method: 'POST', body: { productId: product.id } });
    const next = { ...pi, productId: product.id };
    setIntent(next);
    return next;
  }

  function finish(pi, card) {
    setResult({ pi, card, product });
    setIntent(null);
    setThreeDs(null);
    setFailure(null);
  }

  function fail(err) {
    setThreeDs(null);
    setFailure({ message: paymentErrorMessage(err), code: err.declineCode || err.code });
  }

  async function onTokenized(pm) {
    setFailure(null);
    const card = { brand: pm.card.brand, last4: pm.card.last4 };
    try {
      const pi = await ensureIntent();
      const confirmed = await api(`/v1/payment_intents/${pi.id}/confirm`, {
        method: 'POST',
        key: pk,
        body: { payment_method: pm.id, client_secret: pi.client_secret },
      });
      if (confirmed.status === 'requires_action' && confirmed.next_action?.type === 'three_d_secure') {
        setThreeDs({ challengeId: confirmed.next_action.challenge_id, card });
      } else if (confirmed.status === 'succeeded' || confirmed.status === 'requires_capture') {
        finish(confirmed, card);
      } else {
        fail({ message: 'Le paiement n’a pas abouti. Réessayez.' });
      }
    } catch (err) {
      fail(err);
    }
  }

  async function decide(decision) {
    setDeciding(true);
    try {
      const pi = await api(`/v1/three_ds/${threeDs.challengeId}/complete`, {
        method: 'POST',
        key: pk,
        body: { result: decision, client_secret: intent.client_secret },
      });
      if (pi.status === 'succeeded' || pi.status === 'requires_capture') finish(pi, threeDs.card);
      else fail({ message: 'Le paiement n’a pas abouti. Réessayez.' });
    } catch (err) {
      fail(err);
    } finally {
      setDeciding(false);
    }
  }

  if (result) return <Receipt shop={config.shop} result={result} onAgain={() => setResult(null)} />;

  return (
    <main className="page checkout">
      <header className="page-head">
        <p className="shop-name">{config.shop}</p>
        <h1>Boutique</h1>
        <p className="lede">Choisissez un article, puis payez avec une carte de test.</p>
      </header>

      <div className="checkout-grid">
        <section aria-labelledby="products-title" className="products">
          <h2 id="products-title" className="visually-hidden">Articles</h2>
          <ul className="product-list" role="radiogroup" aria-label="Article à acheter">
            {products.map((p) => {
              const active = p.id === product.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`product ${active ? 'is-active' : ''}`}
                    onClick={() => choose(p.id)}
                  >
                    <span className="product-radio" aria-hidden="true" />
                    <span className="product-text">
                      <span className="product-name">{p.name}</span>
                      <span className="product-desc">{p.description}</span>
                      {p.marketplace && (
                        <span className="product-seller">
                          Vendu par {p.marketplace.seller_name} · {100 - p.marketplace.platform_fee_percent} % reversés au vendeur
                        </span>
                      )}
                    </span>
                    <Money cents={p.amount} className="product-price" />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="aside-link">
            Envie d’un café chaque mois ? <Link to="/subscribe">Découvrir l’abonnement</Link>
          </p>
        </section>

        <section className="pay-panel" aria-labelledby="pay-title">
          <div className="order-line">
            <h2 id="pay-title" className="h-small">Paiement</h2>
            <p>
              <span className="muted">{product.name}</span>
              <Money cents={product.amount} className="order-total" />
            </p>
          </div>
          {failure && (
            <div className="note note-bad" role="alert" data-testid="payment-error">
              <p className="note-title">Paiement refusé</p>
              <p>{failure.message}</p>
            </div>
          )}
          <CardForm ref={formRef} publishableKey={pk} submitLabel={`Payer ${formatAmount(product.amount)}`} disabled={Boolean(threeDs)} onTokenized={onTokenized} />
          <TestCards onPick={(n) => formRef.current?.prefill(n)} />
        </section>
      </div>

      {threeDs && intent && <ThreeDsModal merchant={config.shop} amount={intent.amount} card={threeDs.card} busy={deciding} onDecide={decide} />}
    </main>
  );
}

function Receipt({ shop, result, onAgain }) {
  const { pi, card, product } = result;
  const authorizedOnly = pi.status === 'requires_capture';
  return (
    <main className="page receipt-page">
      <div className="receipt" data-testid="receipt">
        <p className="receipt-status">
          <span className="check" aria-hidden="true" />
          {authorizedOnly ? 'Paiement autorisé' : 'Paiement accepté'}
        </p>
        <p className="receipt-amount"><Money cents={pi.amount} /></p>
        <p className="receipt-sub">
          payés à {shop} pour <strong>{product.name}</strong>
        </p>
        <dl className="receipt-lines">
          <div>
            <dt>Carte</dt>
            <dd>
              {BRAND_LABELS[card.brand] || card.brand} •••• {card.last4}
            </dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{formatLongDateTime(pi.created)}</dd>
          </div>
          {product.marketplace && (
            <div>
              <dt>Vendeur</dt>
              <dd>{product.marketplace.seller_name}</dd>
            </div>
          )}
          <div>
            <dt>Référence</dt>
            <dd>
              <code className="id">{pi.id}</code>
            </dd>
          </div>
        </dl>
        <div className="receipt-actions">
          <button type="button" className="btn btn-primary" onClick={onAgain}>
            Faire un autre achat
          </button>
          <Link className="btn btn-ghost" to="/dashboard">
            Voir dans le tableau de bord
          </Link>
        </div>
      </div>
    </main>
  );
}
