// src/routes/stripe/checkout.ts
import express from "express";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import pool from "../../lib/db";

const router = express.Router();

router.post("/checkout", async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Config Stripe faltante" });

  const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.aamy.ai";
  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });

  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "No autorizado" });

  // ✅ NUEVO: priceId (modo dinámico)
  const priceIdRaw = (req.body?.priceId || req.query?.priceId) as string | undefined;
  const priceId = priceIdRaw ? String(priceIdRaw).trim() : null;

  // ✅ Compatibilidad: plan
  const planRaw = (req.body?.plan || req.query?.plan || "initial_399") as string;
  const plan = String(planRaw).toLowerCase().trim();

  // Variables antiguas por plan
  const PRICE_INITIAL_399 = process.env.STRIPE_PRICE_INITIAL_399;
  const PRICE_TEST_0 = process.env.STRIPE_PRICE_TEST_0;

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const tenantId: string = decoded.tenant_id || decoded.uid;

    // Email del usuario
    const u = await pool.query(
      `
      SELECT email
      FROM users
      WHERE tenant_id::text = $1 OR uid::text = $1
      LIMIT 1
      `,
      [tenantId]
    );

    const email: string | undefined = u.rows[0]?.email;
    if (!email) return res.status(404).json({ error: "Usuario no encontrado" });

    // =========================================================
    // 1) MODO DINÁMICO: si viene priceId -> usarlo directo
    // =========================================================
    if (priceId) {
      const price = await stripe.prices.retrieve(priceId);

      const mode: Stripe.Checkout.SessionCreateParams.Mode =
        price.type === "recurring" ? "subscription" : "payment";

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: {
          tenant_id: tenantId,
          purpose: mode === "subscription" ? "aamy_membership" : "aamy_payment",
          price_id: priceId,
        },
        client_reference_id: tenantId,
        customer_email: email,
        success_url: `${FRONTEND_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/upgrade?canceled=1`,
      };

      // ✅ SOLO en payment se permite customer_creation
      if (mode === "payment") {
        sessionParams.customer_creation = "always";
        sessionParams.payment_intent_data = {
          setup_future_usage: "off_session",
        };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
      return res.json({ url: session.url });
    }

    // =========================================================
    // 2) COMPATIBILIDAD: plan "test" (subscription $0)
    // =========================================================
    if (plan === "test") {
      if (!PRICE_TEST_0) return res.status(500).json({ error: "STRIPE_PRICE_TEST_0 faltante" });

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: PRICE_TEST_0, quantity: 1 }],
        metadata: {
          tenant_id: tenantId,
          purpose: "aamy_test_0",
          plan: "test",
        },
        client_reference_id: tenantId,
        customer_email: email,
        success_url: `${FRONTEND_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/upgrade?canceled=1`,
      });

      return res.json({ url: session.url });
    }

    // =========================================================
    // 3) DEFAULT: pago inicial $399 (payment)
    // =========================================================
    if (!PRICE_INITIAL_399) return res.status(500).json({ error: "STRIPE_PRICE_INITIAL_399 faltante" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_creation: "always", // ✅ permitido aquí
      line_items: [{ price: PRICE_INITIAL_399, quantity: 1 }],
      payment_intent_data: {
        setup_future_usage: "off_session",
      },
      metadata: {
        tenant_id: tenantId,
        purpose: "aamy_initial_399",
        plan: "initial_399",
      },
      client_reference_id: tenantId,
      customer_email: email,
      success_url: `${FRONTEND_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/upgrade?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Error creando sesión Stripe:", err);
    return res.status(500).json({ error: "Error creando sesión de checkout" });
  }
});

export default router;
