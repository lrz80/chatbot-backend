// src/routes/stripe/checkout-credit.ts

import express from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pool from '../../lib/db';

const router = express.Router();

router.post('/checkout-credit', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!STRIPE_SECRET_KEY || !JWT_SECRET) {
    return res.status(500).json({ error: 'Stripe o JWT no configurados correctamente.' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2022-11-15',
  });

  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { uid: string };
    const uid = decoded.uid;

    const result = await pool.query(
      'SELECT email, tenant_id FROM users WHERE uid = $1',
      [uid]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const { canal, cantidad, redirectPath } = req.body;

    const canalesPermitidos = ["sms", "email", "whatsapp", "contactos"];
    const cantidadesPermitidas = [500, 1000, 2000];

    if (!canalesPermitidos.includes(canal)) {
      return res.status(400).json({ error: 'Canal inválido.' });
    }

    if (!cantidadesPermitidas.includes(Number(cantidad))) {
      return res.status(400).json({ error: 'Cantidad inválida.' });
    }

    const preciosPorCanal: Record<string, Record<number, number>> = {
      contactos: { 500: 15, 1000: 20, 2000: 30 },
      email:     { 500: 15, 1000: 20, 2000: 30 },
      sms:       { 500: 15, 1000: 20, 2000: 30 },
      whatsapp:  { 500: 15, 1000: 20, 2000: 30 },
    };

    const precioUSD = preciosPorCanal[canal]?.[cantidad];
    if (!precioUSD) {
      return res.status(400).json({ error: 'Precio no encontrado para la combinación solicitada.' });
    }

    const productName =
      canal === "contactos"
        ? `+${cantidad} contactos adicionales`
        : `+${cantidad} créditos ${canal.toUpperCase()}`;

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
            product_data: { name: productName },
            unit_amount: precioUSD * 100, // Stripe acepta centavos
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
    console.error('❌ Error en checkout-credit:', (err as Error).message || err);
    return res.status(500).json({ error: 'Error interno al crear sesión de pago.' });
  }
});

export default router;
