// src/routes/stripe/checkout.ts
import express from "express";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import pool from "../../lib/db";

const LEGAL_VERSION = "aamy_voice_pro_v1_2026_05_11";

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

  const acceptedLegal =
    req.body?.acceptedLegal === true ||
    req.body?.acceptedLegal === "true";

  if (!acceptedLegal) {
    return res.status(400).json({
      error: "You must accept the legal terms before subscribing.",
    });
  }

  // Variables antiguas por plan
  const PRICE_INITIAL_399 = process.env.STRIPE_PRICE_INITIAL_399;
  const PRICE_TEST_0 = process.env.STRIPE_PRICE_TEST_0;

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const tenantId: string = decoded.tenant_id || decoded.uid;
    if (!tenantId) return res.status(401).json({ error: "No tenant_id en token" });

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

    const ipAddress =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      null;

    const userAgent =
      req.headers["user-agent"]?.toString() || null;

    const legalAcceptanceResult = await pool.query(
      `
      INSERT INTO legal_acceptances (
        tenant_id,
        email,
        ip_address,
        user_agent,

        accepted_terms,
        accepted_privacy,
        accepted_acceptable_use,
        accepted_annual_commitment,

        legal_version,

        plan_name,
        monthly_price_cents,
        currency,
        commitment_months,
        cancellation_window_days,
        early_termination_fee_months
      )
      VALUES (
        $1,$2,$3,$4,
        true,true,true,true,
        $5,
        'Aamy Voice Pro',
        25000,
        'usd',
        12,
        30,
        3
      )
      RETURNING id
      `,
      [
        tenantId,
        email,
        ipAddress,
        userAgent,
        LEGAL_VERSION,
      ]
    );

    const legalAcceptanceId =
      legalAcceptanceResult.rows[0]?.id;

    // =========================================================
    // 1) MODO DINÁMICO: si viene priceId -> usarlo directo
    // =========================================================
    if (priceId) {
      const price = await stripe.prices.retrieve(priceId, {
        expand: ["product"],
      });

      if (!price.active) {
        return res.status(400).json({
          error: "This plan is no longer available.",
        });
      }

      if (!price.product || typeof price.product === "string") {
        return res.status(400).json({
          error: "Invalid Stripe product.",
        });
      }

      const product = price.product as Stripe.Product;

      if (!product.active) {
        return res.status(400).json({
          error: "This product is no longer available.",
        });
      }

      const productMetadata = product.metadata || {};

      const checkoutCouponId =
        typeof productMetadata.checkout_coupon_id === "string" &&
        productMetadata.checkout_coupon_id.trim()
          ? productMetadata.checkout_coupon_id.trim()
          : null;

      const mode: Stripe.Checkout.SessionCreateParams.Mode =
        price.type === "recurring" ? "subscription" : "payment";

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode,
        line_items: [{ price: priceId, quantity: 1 }],

        metadata: {
          tenant_id: tenantId,
          purpose: mode === "subscription" ? "aamy_membership" : "aamy_payment",
          price_id: priceId,
          product_id: product.id,

          legal_acceptance_id: legalAcceptanceId,
          legal_version: LEGAL_VERSION,
          accepted_annual_commitment: "true",
        },

        client_reference_id: tenantId,
        customer_email: email,

        success_url: `${FRONTEND_URL}/dashboard/profile`,
        cancel_url: `${FRONTEND_URL}/upgrade?canceled=1`,
      };

      if (checkoutCouponId) {
        sessionParams.discounts = [
          {
            coupon: checkoutCouponId,
          },
        ];
      }

      if (mode === "subscription") {
        sessionParams.subscription_data = {
          metadata: {
            tenant_id: tenantId,
            purpose: "aamy_membership",
            price_id: priceId,
            product_id: product.id,

            legal_acceptance_id: legalAcceptanceId,
            legal_version: LEGAL_VERSION,
            accepted_annual_commitment: "true",
          },
        };
      }

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

          legal_acceptance_id: legalAcceptanceId,
          legal_version: LEGAL_VERSION,
          accepted_annual_commitment: "true",
        },

        // ✅ CRÍTICO: subscription.metadata
        subscription_data: {
          metadata: {
            tenant_id: tenantId,
            purpose: "aamy_test_0",
            plan: "test",

            legal_acceptance_id: legalAcceptanceId,
            legal_version: LEGAL_VERSION,
            accepted_annual_commitment: "true",
          },
        },

        client_reference_id: tenantId,
        customer_email: email,
        success_url: `${FRONTEND_URL}/dashboard/profile`,
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

        legal_acceptance_id: legalAcceptanceId,
        legal_version: LEGAL_VERSION,
        accepted_annual_commitment: "true",
      },
      client_reference_id: tenantId,
      customer_email: email,
      success_url: `${FRONTEND_URL}/dashboard/profile`,
      cancel_url: `${FRONTEND_URL}/upgrade?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe checkout session creation failed:", {
      message: err instanceof Error ? err.message : String(err),
      err,
    });

    return res.status(500).json({
      error: "Failed to create checkout session.",
    });
  }
});

export default router;
