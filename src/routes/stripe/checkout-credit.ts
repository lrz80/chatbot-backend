// src/routes/stripe/checkout-credit.ts

import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();

router.post('/checkout-credit', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe no configurado correctamente.' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2025-03-31.basil',
  });

  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Token requerido.' });
  }

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const uid = decoded.uid;

    const result = await pool.query('SELECT email, tenant_id FROM users WHERE uid = $1', [uid]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const { canal, cantidad, redirectPath } = req.body;

    // ✅ Añadimos "contactos" como canal válido
    if (!["sms", "email", "whatsapp", "contactos"].includes(canal)) {
      return res.status(400).json({ error: 'Canal inválido' });
    }

    const precios: Record<number, number> = {
      500: 10,
      1000: 18,
      2000: 34,
    };

    const precioUSD = precios[cantidad];
    if (!precioUSD) return res.status(400).json({ error: 'Cantidad no válida' });

    // ✅ Nombre dinámico
    const productName =
      canal === "contactos"
        ? `+${cantidad} contactos adicionales`
        : `+${cantidad} créditos ${canal.toUpperCase()}`;

    // ✅ Validar ruta personalizada o usar fallback
    const redirect = typeof redirectPath === "string" && redirectPath.startsWith("/dashboard/campaigns/")
      ? redirectPath
      : `/dashboard/campaigns/${canal}`;

    const successParam = canal === "contactos" ? "contactos=ok" : "credito=ok";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: user.email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: productName,
            },
            unit_amount: precioUSD * 100,
          },
          quantity: 1,
        },
      ],
      metadata: {
        tenant_id: user.tenant_id,
        canal,
        cantidad,
      },
      success_url: `https://www.aamy.ai${redirect}?${successParam}`,
      cancel_url: `https://www.aamy.ai${redirect}?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Error en checkout-credit:', err);
    return res.status(500).json({ error: 'Error interno al crear sesión de pago' });
  }
});

export default router;
