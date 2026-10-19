import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { BRAND_LABELS, BRAND_SHORT, detectBrand, formatCardNumber, formatExpiry, luhnValid } from '../lib/format.js';
import { paymentErrorMessage } from '../lib/messages.js';

const EMPTY = { number: '', expiry: '', cvc: '' };

function BrandMark({ brand }) {
  return (
    <span className={`brand brand-${brand || 'none'}`} aria-live="polite" aria-label={brand ? `Carte ${BRAND_LABELS[brand]} détectée` : 'Marque non détectée'}>
      {brand ? BRAND_SHORT[brand] : 'Carte'}
    </span>
  );
}

/** Contrôles locaux (confort) ; le coffre-fort PaySim refait toutes les vérifications côté serveur. */
function validateLocally({ number, expiry, cvc }) {
  const digits = number.replace(/\D/g, '');
  const errors = {};
  if (digits.length < 13) errors.number = 'Numéro incomplet.';
  else if (!luhnValid(digits)) errors.number = 'Ce numéro de carte n’est pas valide.';
  else if (!detectBrand(digits)) errors.number = 'Seules Visa, Mastercard et American Express sont acceptées.';
  const m = /^(\d{2}) \/ (\d{2})$/.exec(expiry);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) errors.expiry = 'Format MM / AA.';
  else {
    const now = new Date();
    const year = 2000 + Number(m[2]);
    const month = Number(m[1]);
    if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) errors.expiry = 'Carte expirée.';
  }
  const cvcLen = detectBrand(digits) === 'amex' ? 4 : 3;
  if (!new RegExp(`^\\d{${cvcLen}}$`).test(cvc)) errors.cvc = `${cvcLen} chiffres.`;
  return { errors, digits, month: m ? Number(m[1]) : 0, year: m ? 2000 + Number(m[2]) : 0 };
}

/**
 * Formulaire carte. La carte est envoyée DIRECTEMENT à PaySim (POST /v1/payment_methods, clé publique) et jamais au
 * marchand. Les champs vivent dans un état React local (mémoire du composant, rien dans localStorage/URL) et sont
 * vidés dès que la carte est tokenisée. Le parent ne reçoit que le pm_ (id, marque, 4 derniers chiffres).
 *
 * Ref : prefill(number) remplit une carte de test.
 */
export const CardForm = forwardRef(function CardForm({ publishableKey, submitLabel, disabled, onTokenized, onError }, ref) {
  const [card, setCard] = useState(EMPTY);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState(null);
  const numberRef = useRef(null);

  useImperativeHandle(ref, () => ({
    prefill(number) {
      const next = new Date();
      const yy = String((next.getFullYear() + 3) % 100).padStart(2, '0');
      setCard({ number: formatCardNumber(number), expiry: `12 / ${yy}`, cvc: detectBrand(number) === 'amex' ? '1234' : '123' });
      setTouched({});
      setSubmitted(false);
      setFieldError(null);
      numberRef.current?.focus();
    },
  }));

  const digits = card.number.replace(/\D/g, '');
  const brand = detectBrand(digits);
  const { errors } = validateLocally(card);
  const show = (f) => (submitted || touched[f]) && errors[f];

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitted(true);
    setFieldError(null);
    const v = validateLocally(card);
    if (Object.keys(v.errors).length) return;
    setBusy(true);
    let pm;
    try {
      pm = await api('/v1/payment_methods', {
        method: 'POST',
        key: publishableKey,
        body: { card: { number: v.digits, exp_month: v.month, exp_year: v.year, cvc: card.cvc } },
      });
    } catch (err) {
      setBusy(false);
      setFieldError(paymentErrorMessage(err));
      onError?.(err);
      return;
    }
    // Carte tokenisée : on efface immédiatement le numéro, la date et le CVC de la mémoire du composant.
    setCard(EMPTY);
    setTouched({});
    setSubmitted(false);
    try {
      await onTokenized(pm);
    } finally {
      setBusy(false);
    }
  }

  const blur = (f) => () => setTouched((t) => ({ ...t, [f]: true }));

  return (
    <form className="cardform" onSubmit={handleSubmit} noValidate aria-busy={busy}>
      <div className="field">
        <label htmlFor="cc-number">Numéro de carte</label>
        <div className="input-with-brand">
          <input
            id="cc-number"
            ref={numberRef}
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="1234 1234 1234 1234"
            value={card.number}
            onChange={(e) => setCard((c) => ({ ...c, number: formatCardNumber(e.target.value) }))}
            onBlur={blur('number')}
            aria-invalid={Boolean(show('number'))}
            aria-describedby={show('number') ? 'cc-number-err' : undefined}
            disabled={busy || disabled}
          />
          <BrandMark brand={brand} />
        </div>
        {show('number') && <p id="cc-number-err" className="field-error">{errors.number}</p>}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="cc-exp">Expiration</label>
          <input
            id="cc-exp"
            inputMode="numeric"
            autoComplete="cc-exp"
            placeholder="MM / AA"
            value={card.expiry}
            onChange={(e) => {
              const raw = e.target.value;
              // Effacement du séparateur : on retire aussi le chiffre qui précède.
              const deleting = raw.length < card.expiry.length && card.expiry.endsWith(' / ') && !raw.endsWith(' / ');
              setCard((c) => ({ ...c, expiry: formatExpiry(deleting ? raw.replace(/\D/g, '').slice(0, -1) : raw) }));
            }}
            onBlur={blur('expiry')}
            aria-invalid={Boolean(show('expiry'))}
            aria-describedby={show('expiry') ? 'cc-exp-err' : undefined}
            disabled={busy || disabled}
          />
          {show('expiry') && <p id="cc-exp-err" className="field-error">{errors.expiry}</p>}
        </div>
        <div className="field">
          <label htmlFor="cc-cvc">CVC</label>
          <input
            id="cc-cvc"
            inputMode="numeric"
            autoComplete="cc-csc"
            placeholder={brand === 'amex' ? '1234' : '123'}
            value={card.cvc}
            onChange={(e) => setCard((c) => ({ ...c, cvc: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
            onBlur={blur('cvc')}
            aria-invalid={Boolean(show('cvc'))}
            aria-describedby={show('cvc') ? 'cc-cvc-err' : undefined}
            disabled={busy || disabled}
          />
          {show('cvc') && <p id="cc-cvc-err" className="field-error">{errors.cvc}</p>}
        </div>
      </div>
      {fieldError && (
        <p className="note note-bad" role="alert">
          {fieldError}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || disabled}>
        {busy ? 'Paiement en cours…' : submitLabel}
      </button>
      <p className="secure-note small muted">
        Votre carte est transmise directement à PaySim, jamais au site marchand.
      </p>
    </form>
  );
});
