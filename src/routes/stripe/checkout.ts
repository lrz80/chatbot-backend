// src/routes/stripe/checkout.ts
import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';
import { hasUsedTrialByEmail } from '../../lib/trial'; // ⬅️ NUEVO

const router = express.Router();

router.post('/checkout', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Config Stripe faltante' });

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const tenantId: string = decoded.uid;

    // 👉 viene del front: cuál price_id escogió el cliente
    const price_id: string | undefined = req.body?.price_id;
    if (!price_id) return res.status(400).json({ error: 'price_id requerido' });

    // email del usuario (base para decidir trial por email)
    const u = await pool.query('SELECT email FROM users WHERE uid = $1', [tenantId]);
    const email: string | undefined = u.rows[0]?.email;
    if (!email) return res.status(404).json({ error: 'Usuario no encontrado' });

    // ✅ ¿ese EMAIL ya usó trial alguna vez? (registro permanente)
    const alreadyTookTrialByEmail = await hasUsedTrialByEmail(email);

    // (Opcional) por compatibilidad con tenants existentes que ya marcaron el trial
    const t = await pool.query(
      'SELECT COALESCE(trial_ever_claimed,false) AS used FROM tenants WHERE id = $1',
      [tenantId]
    );
    const alreadyTookTrialByTenant = !!t.rows[0]?.used;

    // Solo permitimos trial si JAMÁS lo usó por email NI por tenant previo
    const allow_trial = !(alreadyTookTrialByEmail || alreadyTookTrialByTenant);

    // Armamos subscription_data condicional (solo añadimos trial si corresponde)
    const subscription_data: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
      metadata: { tenant_id: tenantId }, // útil para el webhook
      ...(allow_trial ? { trial_period_days: 14 } : {}),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      metadata: {
        tenant_id: tenantId, // leído por el webhook
        price_id,
      },
      line_items: [{ price: price_id, quantity: 1 }],
      subscription_data,                         // ⬅️ aquí aplicamos o no el trial
      allow_promotion_codes: true,
      client_reference_id: tenantId,
      success_url: 'https://aamy.ai/dashboard?success=1',
      cancel_url:  'https://aamy.ai/upgrade?canceled=1',
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Error creando sesión de Stripe:', err);
    return res.status(500).json({ error: 'Error creando sesión de pago' });
  }
});

export default router;
