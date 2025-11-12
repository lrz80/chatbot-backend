// src/routes/stripe/checkout.ts
import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();

router.post('/checkout', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Config Stripe faltante' });

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const tenantId = decoded.uid;

    // 👉 viene del front
    const price_id: string | undefined = req.body?.price_id;
    if (!price_id) return res.status(400).json({ error: 'price_id requerido' });

    // email del usuario
    const u = await pool.query('SELECT email FROM users WHERE uid=$1', [tenantId]);
    const email = u.rows[0]?.email;
    if (!email) return res.status(404).json({ error: 'Usuario no encontrado' });

    // ¿ya usó prueba antes?
    const t = await pool.query(
      'SELECT COALESCE(trial_ever_claimed,false) AS used FROM tenants WHERE id=$1',
      [tenantId]
    );
    const trial_already_used = !!t.rows[0]?.used;

    // Si NUNCA usó prueba, damos 14 días. Si ya la usó, SIN trial.
    const allow_trial = !trial_already_used;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      metadata: {
        tenant_id: tenantId,
        price_id,
      },
      line_items: [{ price: price_id, quantity: 1 }],
      ...(allow_trial ? { subscription_data: { trial_period_days: 14 } } : {}),
      allow_promotion_codes: true,
      client_reference_id: tenantId,
      success_url: 'https://aamy.ai/dashboard?success=1',
      cancel_url: 'https://aamy.ai/upgrade?canceled=1',
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Error creando sesión de Stripe:', err);
    return res.status(500).json({ error: 'Error creando sesión de pago' });
  }
});

export default router;
