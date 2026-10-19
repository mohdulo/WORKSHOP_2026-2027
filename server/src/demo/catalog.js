'use strict';

/**
 * Catalogue de la boutique de démonstration « Comptoir des Pentes » (PLAN §4.11).
 * Source de vérité des PRIX : le navigateur n'envoie qu'un identifiant de produit, jamais un montant.
 * Montants en centimes (entiers).
 */
const SHOP_NAME = 'Comptoir des Pentes';

/** Vendeur marketplace : reçoit (100 − PLATFORM_FEE_PERCENT) % des produits `marketplace: true`. */
const DEMO_SELLER = Object.freeze({ email: 'atelier-lyonnais@demo.paysim.test', business_name: 'Atelier Lyonnais' });
const PLATFORM_FEE_PERCENT = 15;

const ONE_TIME_PRODUCTS = Object.freeze([
  {
    key: 'cafe_croix_rousse',
    name: 'Café de la Croix-Rousse, 250 g',
    description: 'Torréfié chaque semaine sur les pentes, en grains.',
    amount: 1250,
  },
  {
    key: 'carnet_relie',
    name: 'Carnet relié main',
    description: '96 pages en papier recyclé, couverture en lin.',
    amount: 1890,
  },
  {
    key: 'planche_noyer',
    name: 'Planche à découper en noyer',
    description: "Fabriquée à Lyon par l'Atelier Lyonnais, vendeur partenaire.",
    amount: 4800,
    marketplace: true,
  },
]);

const SUBSCRIPTION_PRODUCT = Object.freeze({
  key: 'cafe_du_mois',
  name: 'Café du mois',
  description: "250 g d'un café différent, livré chaque mois.",
  amount: 990,
  interval: 'month',
});

/** Commission plateforme en centimes : arrondi au plus proche, calcul entier (taskForLesson L3). */
function platformFee(amount) {
  return Math.floor((amount * PLATFORM_FEE_PERCENT + 50) / 100);
}

module.exports = { SHOP_NAME, DEMO_SELLER, PLATFORM_FEE_PERCENT, ONE_TIME_PRODUCTS, SUBSCRIPTION_PRODUCT, platformFee };
