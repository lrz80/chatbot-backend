// src/routes/stripe/checkout.ts
import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();

router.post('/checkout', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Config Stripe faltante' });

  const PRICE_INITIAL_399 = process.env.STRIPE_PRICE_INITIAL_399;
  if (!PRICE_INITIAL_399) return res.status(500).json({ error: 'STRIPE_PRICE_INITIAL_399 faltante' });

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.aamy.ai';

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const tenantId: string = decoded.tenant_id || decoded.uid; // por compatibilidad

    // Email del usuario (Stripe lo usa para crear Customer + Receipt)
    const u = await pool.query(
      `SELECT email
      FROM users
      WHERE tenant_id::text = $1 OR uid::text = $1
      LIMIT 1`,
      [tenantId]
    );
    const email: string | undefined = u.rows[0]?.email;
    if (!email) return res.status(404).json({ error: 'Usuario no encontrado' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_creation: 'always',
      line_items: [{ price: PRICE_INITIAL_399, quantity: 1 }],
      payment_intent_data: {
        // guarda el método de pago para futuros cobros (la suscripción mensual)
        setup_future_usage: 'off_session',
      },
      metadata: {
        tenant_id: tenantId,
        purpose: 'aamy_initial_399',
      },
      client_reference_id: tenantId,
      customer_email: email,
      success_url: `${FRONTEND_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/upgrade?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Error creando sesión Stripe (payment $399):', err);
    return res.status(500).json({ error: 'Error creando sesión de pago' });
  }
});

export default router;
