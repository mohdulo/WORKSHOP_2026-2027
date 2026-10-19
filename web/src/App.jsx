import { NavLink, Navigate, Route, Routes, Link } from 'react-router-dom';
import { DemoConfigProvider } from './lib/DemoConfig.jsx';
import { SecretKeyProvider } from './lib/SecretKey.jsx';
import Checkout from './pages/Checkout.jsx';
import Subscribe from './pages/Subscribe.jsx';
import Dashboard from './pages/Dashboard.jsx';

export default function App() {
  return (
    <DemoConfigProvider>
      <SecretKeyProvider>
        <a className="skip-link" href="#contenu">Aller au contenu</a>
        <header className="topbar">
          <Link to="/checkout" className="wordmark" aria-label="PaySim, accueil">
            <span className="wordmark-mark" aria-hidden="true" />
            PaySim
          </Link>
          <nav aria-label="Navigation principale" className="topnav">
            <NavLink to="/checkout">Boutique</NavLink>
            <NavLink to="/subscribe">Abonnement</NavLink>
            <NavLink to="/dashboard">Tableau de bord</NavLink>
          </nav>
          <span className="testmode" title="Aucun argent réel ne circule : banques et réseaux carte sont simulés.">Mode test</span>
        </header>
        <div id="contenu">
          <Routes>
            <Route path="/" element={<Navigate to="/checkout" replace />} />
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/subscribe" element={<Subscribe />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
        <footer className="footer small muted">
          PaySim est un prestataire de paiement pédagogique (projet EPSI). Banques et réseaux carte sont simulés : aucun paiement réel.
        </footer>
      </SecretKeyProvider>
    </DemoConfigProvider>
  );
}

function NotFound() {
  return (
    <main className="page">
      <h1>Page introuvable</h1>
      <p><Link to="/checkout">Retourner à la boutique</Link></p>
    </main>
  );
}
