// src/routes/stripe/checkout.ts
import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();

// ⚙️ Sube este PRICE_ID a tu .env si prefieres: STRIPE_PRICE_PRO=price_...
const PRICE_ID = process.env.STRIPE_PRICE_PRO || 'price_1R8C4K05RmqANw5eLQo1xPMU';

// POST /api/stripe/checkout
router.post('/checkout', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  if (!STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY no está definida en variables de entorno.');
    return res.status(500).json({ error: 'Configuración incompleta de Stripe' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'No autorizado. Token requerido.' });
  }

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const uid = decoded.uid;

    const result = await pool.query('SELECT email FROM users WHERE uid = $1', [uid]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,

      // 👇 MUY IMPORTANTE: metadata para que el webhook active canales al terminar
      metadata: {
        tenant_id: uid,          // el webhook lo leerá como session.metadata.tenant_id
        plan: 'amy_pro',         // opcional, informativo
        price_id: PRICE_ID,      // opcional, informativo
      },

      line_items: [
        {
          price: PRICE_ID,
          quantity: 1,
        },
      ],

      // si mantienes trial
      subscription_data: {
        trial_period_days: 14,
      },

      // (opcional) permitir cupones
      allow_promotion_codes: true,

      // (opcional) para trazabilidad
      client_reference_id: uid,

      // Usa tu dominio raíz (recomiendo sin www si ya migraste)
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
