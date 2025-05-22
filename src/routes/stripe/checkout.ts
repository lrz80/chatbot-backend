// src/routes/stripe/checkout.ts

import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();

// POST /api/stripe/checkout
router.post('/checkout', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  if (!STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY no está definida en variables de entorno.');
    return res.status(500).json({ error: 'Configuración incompleta de Stripe' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2022-11-15',
  });

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
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: user.email,
      line_items: [
        {
          price: 'price_1R8C4K05RmqANw5eLQo1xPMU',
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 7,
      },
      success_url: 'https://www.aamy.ai/dashboard?success=1',
      cancel_url: 'https://www.aamy.ai/upgrade?canceled=1',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error creando sesión de Stripe:', error);
    res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

export default router;
