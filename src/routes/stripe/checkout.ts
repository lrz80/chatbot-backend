import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// POST /api/stripe/checkout
router.post('/checkout', async (req, res) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: 'No autorizado. Token requerido.' });
  }

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const uid = decoded.uid;

    // Obtener el correo del usuario
    const result = await pool.query('SELECT email FROM users WHERE uid = $1', [uid]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // ⚠️ Reemplaza este ID con el tuyo real desde Stripe Dashboard
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: user.email,
      line_items: [
        {
          price: 'price_1R8AcL05RmqANw5ePQ1CbtZ8', // << REEMPLAZA este ID
          quantity: 1,
        },
      ],
      success_url: 'https://www.aamy.ai/dashboard?success=1',
      cancel_url: 'https://www.aamy.ai/upgrade?canceled=1',
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Error en /checkout:', err);
    res.status(500).json({ error: 'Error al iniciar el pago' });
  }
});

export default router;
