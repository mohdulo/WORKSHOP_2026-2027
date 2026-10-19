'use strict';
const { invalid, cardError } = require('../lib/errors');
const { CURRENCY } = require('../lib/money');
const { DEMO_SELLER, ONE_TIME_PRODUCTS, SUBSCRIPTION_PRODUCT, PLATFORM_FEE_PERCENT, SHOP_NAME, platformFee } = require('./catalog');

/**
 * « Backend marchand » de démonstration (PLAN §4.11).
 *
 * Il joue le rôle du serveur d'un e-commerçant client de PaySim : il détient la clé secrète et agit avec ses droits.
 * Plutôt que de se rappeler lui-même en HTTP avec `Authorization: Bearer sk_...`, il appelle directement les
 * services (ctx.payments, ctx.billing, …) — exactement ceux qu'exécutent les routes /v1 protégées par sk :
 * aucune logique métier dupliquée, et la clé secrète ne circule nulle part (ni réseau, ni logs, ni réponses).
 *
 * Le navigateur n'envoie JAMAIS de montant : seulement un identifiant de produit ; le prix vient de la base.
 * La carte, elle, ne passe jamais par ici : le front la tokenise directement via POST /v1/payment_methods (pk).
 */
function createDemo(ctx) {
  const { db } = ctx;
  const stmts = {
    productByKey: db.prepare("SELECT id FROM products WHERE json_extract(metadata, '$.demo_key') = ? ORDER BY seq LIMIT 1"),
    priceOf: db.prepare("SELECT * FROM prices WHERE product_id = ? AND active = 1 AND json_extract(metadata, '$.demo_key') = ? ORDER BY seq LIMIT 1"),
    sellerByEmail: db.prepare('SELECT id FROM accounts WHERE email = ? ORDER BY seq LIMIT 1'),
  };

  let catalog = null; // rempli par seed()

  function ensureProduct(def, recurring) {
    let productId = stmts.productByKey.get(def.key)?.id;
    if (!productId) {
      productId = ctx.billing.createProduct({ name: def.name, description: def.description, metadata: { demo_key: def.key } }).id;
    }
    let price = stmts.priceOf.get(productId, def.key);
    if (!price || price.unit_amount !== def.amount) {
      const created = ctx.billing.createPrice({
        product: productId,
        unit_amount: def.amount,
        currency: CURRENCY,
        ...(recurring ? { recurring } : {}),
        metadata: { demo_key: def.key },
      });
      price = { id: created.id, unit_amount: created.unit_amount };
    }
    return { productId, priceId: price.id, amount: price.unit_amount };
  }

  /**
   * Seed IDEMPOTENT : chaque objet est retrouvé par `metadata.demo_key` (produits, prix) ou par e-mail (vendeur)
   * avant d'être créé. Redémarrer le serveur sur la même base ne duplique rien. Une seule transaction.
   */
  const seedTxn = db.transaction(() => {
    const sellerId = stmts.sellerByEmail.get(DEMO_SELLER.email)?.id || ctx.connect.createAccount({ ...DEMO_SELLER }).id;
    const products = ONE_TIME_PRODUCTS.map((def) => {
      const { productId, priceId, amount } = ensureProduct(def, null);
      return {
        id: productId,
        price: priceId,
        key: def.key,
        name: def.name,
        description: def.description,
        amount,
        currency: CURRENCY,
        marketplace: def.marketplace
          ? { seller: sellerId, seller_name: DEMO_SELLER.business_name, platform_fee_percent: PLATFORM_FEE_PERCENT, application_fee_amount: platformFee(amount) }
          : null,
      };
    });
    const sub = ensureProduct(SUBSCRIPTION_PRODUCT, { interval: SUBSCRIPTION_PRODUCT.interval });
    return {
      sellerId,
      products,
      subscriptionPrice: {
        id: sub.priceId,
        product: sub.productId,
        name: SUBSCRIPTION_PRODUCT.name,
        description: SUBSCRIPTION_PRODUCT.description,
        unit_amount: sub.amount,
        currency: CURRENCY,
        interval: SUBSCRIPTION_PRODUCT.interval,
      },
    };
  });

  /**
   * Le cache mémoire n'est rempli qu'APRÈS un vrai commit (taskForLesson L18) : appelé dans une transaction englobante,
   * le seed n'est qu'un SAVEPOINT ; si l'englobante est annulée, les ids mis en cache n'existeraient plus en base.
   */
  function seed() {
    const result = seedTxn();
    if (!db.inTransaction) catalog = result;
    return result;
  }

  function getCatalog() {
    return catalog || seed();
  }

  /** Ce que le navigateur a le droit de voir : la clé PUBLIQUE et le catalogue. Jamais la clé secrète. */
  function config() {
    const c = getCatalog();
    return {
      shop: SHOP_NAME,
      publishableKey: ctx.config.publishableKey,
      products: c.products.map(({ key, ...p }) => p),
      subscriptionPrice: c.subscriptionPrice,
    };
  }

  /** Crée le payment intent d'un produit. Montant, commission et destination viennent du catalogue serveur. */
  function checkout({ productId, capture_method: captureMethod = 'automatic' }) {
    const product = getCatalog().products.find((p) => p.id === productId);
    if (!product) throw invalid(`Produit inconnu : "${productId}".`, 'productId', 'resource_missing');
    const params = {
      amount: product.amount,
      currency: CURRENCY,
      capture_method: captureMethod,
      description: `${SHOP_NAME} — ${product.name}`,
      metadata: { demo_product: product.id, demo_price: product.price },
    };
    if (product.marketplace) {
      params.transfer_data = { destination: product.marketplace.seller };
      params.application_fee_amount = product.marketplace.application_fee_amount;
    }
    const { paymentIntent } = ctx.payments.create(params);
    return { id: paymentIntent.id, client_secret: paymentIntent.client_secret, amount: paymentIntent.amount, currency: paymentIntent.currency };
  }

  /**
   * Client + rattachement de la carte + abonnement mensuel. Tout ou rien pour les ERREURS (pm inconnu, déjà rattaché…) :
   * une seule transaction. Un REFUS de carte n'est pas une erreur (taskForLesson L6) : l'abonnement `incomplete`
   * et sa facture `open` sont committés, puis la route répond 402 avec le decline_code.
   */
  const subscribeTxn = db.transaction(({ email, payment_method: pm, priceId }, { subscriptionPrice }) => {
    if (priceId !== undefined && priceId !== subscriptionPrice.id) throw invalid(`Prix inconnu : "${priceId}".`, 'priceId', 'resource_missing');
    ctx.vault.getRow(pm, 'payment_method'); // référence dans le corps : inconnu → 400 resource_missing (pas 404)
    const customer = ctx.customers.create({ email, metadata: { source: 'demo' } });
    ctx.vault.attach(pm, customer.id); // pm inconnu → 400, déjà rattaché → 400 (annule aussi le client)
    ctx.customers.update(customer.id, { invoice_settings: { default_payment_method: pm } });
    const subscription = ctx.billing.createSubscription({ customer: customer.id, price: subscriptionPrice.id });
    const invoice = ctx.billing.getInvoice(subscription.latest_invoice);
    return { customer, subscription, invoice };
  });

  function subscribe(params) {
    const { customer, subscription, invoice } = subscribeTxn(params, getCatalog()); // catalogue résolu HORS transaction
    const summary = {
      customer: customer.id,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
      },
      invoice: { id: invoice.id, status: invoice.status, amount_due: invoice.amount_due, amount_paid: invoice.amount_paid, currency: invoice.currency },
    };
    if (subscription.status === 'incomplete' && invoice.last_payment_error) {
      const { code, decline_code: declineCode, message } = invoice.last_payment_error;
      return { summary, error: cardError(code, message, { decline_code: declineCode || null, subscription: summary.subscription, invoice: summary.invoice }) };
    }
    return { summary };
  }

  return { seed, config, checkout, subscribe, getCatalog };
}

module.exports = { createDemo };
