// src/routes/stripe/plans.ts
import express from 'express';
import Stripe from 'stripe';

const router = express.Router();

router.get('/plans', async (_req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY no está definida.');
    return res.status(500).json({ error: 'Config Stripe incompleta' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

  try {
    // Trae precios recurrentes activos con su product expandido
    const prices = await stripe.prices.list({
      active: true,
      expand: ['data.product'],
      limit: 100,
    });

    const plans = prices.data
      .filter((p) => p.recurring && typeof p.product !== 'string')
      .map((p) => {
        const prod = p.product as Stripe.Product;
        return {
          price_id: p.id,
          product_id: prod.id,
          name: prod.name,                          // ej: "Pro", "Starter"
          description: prod.description || '',
          interval: p.recurring?.interval,          // 'month' | 'year'
          interval_count: p.recurring?.interval_count,
          unit_amount: p.unit_amount,               // en cents
          currency: p.currency,
          // ⚠️ NO usar prod.features: no existe en el tipo.
          // Si algún día lo necesitas, podrías leer (prod as any).features ?? []
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
