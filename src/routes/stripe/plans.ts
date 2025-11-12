// src/routes/stripe/plans.ts
import express from 'express';
import Stripe from 'stripe';

const router = express.Router();

router.get('/plans', async (_req, res) => {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-11-15' });
    const prices = await stripe.prices.list({ active: true, type: 'recurring', expand: ['data.product'], limit: 100 });

    const plans = prices.data
      .filter(p => p.recurring && typeof p.product !== 'string')
      .map(p => {
        const prod = p.product as Stripe.Product;
        return {
          price_id: p.id,
          product_id: prod.id,
          name: prod.name,                        // “Pro”, “Starter”, etc.
          description: prod.description || '',
          interval: p.recurring?.interval,        // month / year
          interval_count: p.recurring?.interval_count || 1,
          unit_amount: p.unit_amount,             // en centavos
          currency: p.currency,
          metadata: prod.metadata || {},
        };
      })
      .sort((a, b) => (a.unit_amount ?? 0) - (b.unit_amount ?? 0));

    res.json({ plans });
  } catch (err) {
    console.error('❌ Error listando planes en Stripe:', err);
    res.status(500).json({ error: 'No se pudieron listar los planes' });
  }
});

export default router;
