// src/routes/stripe/checkout.ts
import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();

// POST /api/stripe/checkout
// body: { price_id: string }
router.post('/checkout', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY no está definida en variables de entorno.');
    return res.status(500).json({ error: 'Configuración incompleta de Stripe' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'No autorizado. Token requerido.' });

  const { price_id } = req.body || {};
  if (!price_id) return res.status(400).json({ error: 'Falta price_id' });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const uid = decoded.uid;

    const result = await pool.query('SELECT email, tenant_id FROM users WHERE uid = $1 LIMIT 1', [uid]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // ⚖️ ¿Tiene trial disponible?
    // trial disponible si NUNCA lo ha usado y no tiene membresía activa
    const tRes = await pool.query(
      `SELECT membresia_activa, COALESCE(trial_ever_claimed,false) AS trial_ever_claimed
         FROM tenants WHERE id = $1 LIMIT 1`,
      [user.tenant_id]
    );
    const t = tRes.rows[0];
    const trialAllowed = Boolean(!t?.trial_ever_claimed && !t?.membresia_activa);

    // Opcional: valida que el price existe y es de tipo recurring
    const price = await stripe.prices.retrieve(price_id);
    if (!price?.recurring) return res.status(400).json({ error: 'El price_id no es de suscripción' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,

      // metadata p/ webhook
      metadata: {
        tenant_id: user.tenant_id,
        price_id,
      },

      line_items: [{ price: price_id, quantity: 1 }],

      // trial solo si aplica; si no, NO lo envies
      ...(trialAllowed
        ? { subscription_data: { trial_period_days: 14 } }
        : {}),

      allow_promotion_codes: true,
      client_reference_id: user.tenant_id,

      success_url: 'https://aamy.ai/dashboard?success=1',
      cancel_url: 'https://aamy.ai/upgrade?canceled=1',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error creando sesión de Stripe:', error);
    res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

export default router;
