// src/routes/stripe/plans.ts
import express from "express";
import Stripe from "stripe";

const router = express.Router();

router.get("/plans", async (_req, res) => {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2022-11-15",
    });

    const prices = await stripe.prices.list({
      active: true,
      type: "recurring",
      expand: ["data.product"],
      limit: 100,
    });

    const plans = prices.data
      .filter((price) => {
        if (!price.active) return false;
        if (!price.recurring) return false;
        if (!price.product || typeof price.product === "string") return false;

        const product = price.product as Stripe.Product;

        return product.active === true;
      })
      .map((price) => {
        const product = price.product as Stripe.Product;

        return {
          price_id: price.id,
          product_id: product.id,
          name: product.name,
          description: product.description || "",
          interval: price.recurring?.interval,
          interval_count: price.recurring?.interval_count || 1,
          unit_amount: price.unit_amount,
          currency: price.currency,
          metadata: {
            ...(product.metadata || {}),
            ...(price.metadata || {}),
          },
        };
      })
      .sort((a, b) => {
        const sortA = Number(a.metadata?.sort_order ?? Number.MAX_SAFE_INTEGER);
        const sortB = Number(b.metadata?.sort_order ?? Number.MAX_SAFE_INTEGER);

        if (Number.isFinite(sortA) && Number.isFinite(sortB) && sortA !== sortB) {
          return sortA - sortB;
        }

        return (a.unit_amount ?? 0) - (b.unit_amount ?? 0);
      });

    res.json({ plans });
  } catch (err) {
    console.error("❌ Error listando planes en Stripe:", err);
    res.status(500).json({ error: "No se pudieron listar los planes" });
  }
});

export default router;