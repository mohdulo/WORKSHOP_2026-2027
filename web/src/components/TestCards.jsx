// Cartes de test du simulateur réseau (PLAN §4.3). Aucune n'est une vraie carte.
export const TEST_CARDS = [
  { number: '4242424242424242', label: 'Paiement accepté', tone: 'ok' },
  { number: '5555555555554444', label: 'Accepté (Mastercard)', tone: 'ok' },
  { number: '4000000000003220', label: 'Demande une validation 3-D Secure', tone: 'info' },
  { number: '4000000000000002', label: 'Refusée par la banque', tone: 'bad' },
  { number: '4000000000009995', label: 'Refusée, fonds insuffisants', tone: 'bad' },
  { number: '4000000000000069', label: 'Refusée, carte expirée', tone: 'bad' },
  { number: '4000000000000127', label: 'Refusée, CVC incorrect', tone: 'bad' },
  { number: '4000000000000341', label: 'Acceptée à l’enregistrement, refusée au paiement', tone: 'bad' },
];

const group = (n) => n.replace(/(\d{4})(?=\d)/g, '$1 ');

export function TestCards({ onPick, subset }) {
  const cards = subset ? TEST_CARDS.filter((c) => subset.includes(c.number)) : TEST_CARDS;
  return (
    <section className="testcards" aria-labelledby="testcards-title">
      <h2 id="testcards-title" className="h-small">Cartes de test</h2>
      <p className="muted small">
        Paiements simulés : aucune somme n’est débitée. N’importe quelle date future et n’importe quel CVC conviennent.
      </p>
      <ul>
        {cards.map((c) => (
          <li key={c.number}>
            <span className={`dot dot-${c.tone}`} aria-hidden="true" />
            <span className="testcard-text">
              <span className="testcard-number">{group(c.number)}</span>
              <span className="testcard-label">{c.label}</span>
            </span>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => onPick(c.number)} aria-label={`Utiliser la carte ${group(c.number)} : ${c.label}`}>
              Utiliser
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
