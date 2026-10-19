import { useEffect, useRef } from 'react';
import { BRAND_LABELS } from '../lib/format.js';
import { Money } from './ui.jsx';

/** Fenêtre 3-D Secure simulée : la « banque » de l'acheteur lui demande de valider le paiement. */
export function ThreeDsModal({ merchant, amount, card, busy, onDecide }) {
  const approveRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    approveRef.current?.focus();
    document.body.classList.add('no-scroll');
    return () => {
      document.body.classList.remove('no-scroll');
      previous?.focus?.();
    };
  }, []);

  // Piège à focus minimal : Tab reste dans la fenêtre ; Échap = refuser.
  function onKeyDown(e) {
    if (e.key === 'Escape' && !busy) onDecide('deny');
    if (e.key !== 'Tab') return;
    const focusables = dialogRef.current.querySelectorAll('button:not([disabled])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="overlay">
      <div className="tds" role="dialog" aria-modal="true" aria-labelledby="tds-title" aria-describedby="tds-desc" ref={dialogRef} onKeyDown={onKeyDown}>
        <div className="tds-bank">
          <span className="tds-bank-name">Banque simulée</span>
          <span className="tds-bank-tag">3-D Secure</span>
        </div>
        <div className="tds-body">
          <h2 id="tds-title">Confirmez ce paiement</h2>
          <p id="tds-desc" className="muted">
            Votre banque vous demande de valider cet achat. Dans la réalité, cette étape se fait dans l’application de la banque.
          </p>
          <dl className="tds-summary">
            <div>
              <dt>Marchand</dt>
              <dd>{merchant}</dd>
            </div>
            <div>
              <dt>Montant</dt>
              <dd><Money cents={amount} /></dd>
            </div>
            {card && (
              <div>
                <dt>Carte</dt>
                <dd>
                  {BRAND_LABELS[card.brand] || card.brand} se terminant par {card.last4}
                </dd>
              </div>
            )}
          </dl>
          <div className="tds-actions">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onDecide('deny')}>
              Refuser
            </button>
            <button type="button" className="btn btn-primary" ref={approveRef} disabled={busy} onClick={() => onDecide('approve')}>
              {busy ? 'Validation…' : 'Approuver'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
