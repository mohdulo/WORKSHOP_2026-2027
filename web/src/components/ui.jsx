import { STATUS_LABELS, STATUS_TONES } from '../lib/messages.js';
import { amountParts } from '../lib/format.js';

/**
 * Montant en euros. Chiffres tabulaires (colonnes alignées), mais la virgule et les espaces gardent leur chasse
 * normale : avec la fonte Schibsted, `tnum` élargit aussi la virgule (« 12 , 50 € »).
 */
export function Money({ cents, className = '' }) {
  return (
    <span className={`money ${className}`}>
      {amountParts(cents).map((p, i) => (p.digits ? <span key={i} className="tnum">{p.value}</span> : p.value))}
    </span>
  );
}

export function StatusBadge({ status }) {
  return <span className={`badge badge-${STATUS_TONES[status] || 'muted'}`}>{STATUS_LABELS[status] || status}</span>;
}

export function Spinner({ label = 'Chargement…' }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div className="note note-bad" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-quiet btn-small" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}

/** Identifiant technique copiable, affiché en entier (police du texte, chiffres tabulaires). */
export function Id({ value }) {
  if (!value) return <span className="muted">—</span>;
  return <code className="id">{value}</code>;
}

/**
 * Tableau réactif : en dessous de 640 px, chaque ligne devient un bloc (étiquette via data-label).
 * columns : [{ key, label, render?(row), align? }]
 */
export function Table({ columns, rows, onRowClick, selectedId, empty = 'Rien à afficher pour le moment.', caption }) {
  if (!rows || rows.length === 0) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        {caption && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === 'right' ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id || row.code}
              className={`${onRowClick ? 'clickable' : ''} ${selectedId && selectedId === (row.id || row.code) ? 'selected' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(row)) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              aria-selected={onRowClick ? selectedId === (row.id || row.code) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={c.align === 'right' ? 'num' : undefined}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
