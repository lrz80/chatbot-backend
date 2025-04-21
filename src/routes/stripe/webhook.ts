import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';
import bodyParser from 'body-parser';

const router = express.Router();

// ⚠️ IMPORTANTE: usa raw body SOLO para esta ruta
router.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const sig = req.headers['stripe-signature'];

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig!, endpointSecret!);
  } catch (err) {
    console.error('⚠️ Webhook error:', err);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  // 👇 Detecta cuando se completa la suscripción
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;

    console.log('✅ Pago exitoso recibido de:', email);

    try {
      // Marca la membresía como activa por 30 días (ajústalo si usas otro plan)
      const vigencia = new Date();
      vigencia.setDate(vigencia.getDate() + 30);

      await pool.query(
        `UPDATE users SET membresia_activa = true, membresia_vigencia = $1 WHERE email = $2`,
        [vigencia, email]
      );

      console.log('🎉 Membresía activada correctamente para', email);
    } catch (err) {
      console.error('❌ Error actualizando la membresía:', err);
    }
  }

  res.status(200).json({ received: true });
});

export default router;
