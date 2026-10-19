// Formatage fr-FR : montants en centimes (entiers) → euros, timestamps Unix (s) → dates françaises.

const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});
const longDateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});

/** 1250 → « 12,50 € ». Division entière pour l'affichage uniquement (les calculs restent en centimes). */
export function formatAmount(cents) {
  if (!Number.isFinite(cents)) return '—';
  return euro.format(cents / 100);
}

/** Découpe un montant formaté en segments chiffres / non-chiffres (pour n'appliquer `tnum` qu'aux chiffres). */
export function amountParts(cents) {
  const text = formatAmount(cents);
  return text.split(/(\d+)/).filter(Boolean).map((value) => ({ value, digits: /^\d+$/.test(value) }));
}

const shortDateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris' });
export const formatShortDate = (ts) => (ts ? shortDateFmt.format(new Date(ts * 1000)) : '—');

export const formatDate = (ts) => (ts ? dateFmt.format(new Date(ts * 1000)) : '—');
export const formatDateTime = (ts) => (ts ? dateTimeFmt.format(new Date(ts * 1000)) : '—');
export const formatLongDateTime = (ts) => (ts ? longDateTimeFmt.format(new Date(ts * 1000)) : '—');

/** « 12,50 » ou « 12.5 » ou « 12 » → 1250 centimes ; null si invalide. Sans flottant (taskForLesson L3). */
export function parseEuros(input) {
  const m = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*(?:€)?\s*$/.exec(String(input));
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

/** 1250 → « 12,50 » (valeur d'un champ de saisie). */
export const centsToInput = (cents) => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;

// ---------- cartes ----------

/** Même règles que le coffre-fort serveur (PLAN §4.2) : visa 4, mastercard 51–55 / 2221–2720, amex 34 / 37. */
export function detectBrand(digits) {
  if (/^4/.test(digits)) return 'visa';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^5[1-5]/.test(digits)) return 'mastercard';
  const p4 = Number(digits.slice(0, 4));
  if (digits.length >= 4 && p4 >= 2221 && p4 <= 2720) return 'mastercard';
  return null;
}

export const BRAND_LABELS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express' };
export const BRAND_SHORT = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex' };

/** « 4242424242424242 » → « 4242 4242 4242 4242 » (groupes de 4, 19 chiffres max). */
export function formatCardNumber(value) {
  const digits = value.replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** « 1230 » → « 12 / 30 ». */
export function formatExpiry(value) {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)} / ${digits.slice(2)}`;
}

export function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export const shortId = (id) => (id && id.length > 16 ? `${id.slice(0, id.indexOf('_') + 5)}…${id.slice(-4)}` : id);
