//src/routes/appointment-booking-flow.ts
import { Router } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = Router();

const VALID_EXPECTED_TYPES = new Set([
  "text",
  "datetime",
  "confirmation",
  "phone",
  "email",
  "number",
]);

router.get("/", authenticateUser, async (req: any, res) => {
  const tenantId = req.user?.tenant_id;

  if (!tenantId) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        tenant_id,
        channel,
        step_key,
        step_order,
        prompt,
        expected_type,
        required,
        enabled,
        created_at,
        updated_at
      FROM appointment_booking_flows
      WHERE tenant_id = $1
        AND channel = 'voice'
      ORDER BY step_order ASC, created_at ASC
      `,
      [tenantId]
    );

    return res.json({
      ok: true,
      steps: rows,
    });
  } catch (err) {
    console.error("❌ [appointment-booking-flow][GET]", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/", authenticateUser, async (req: any, res) => {
  const tenantId = req.user?.tenant_id;

  if (!tenantId) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const steps = Array.isArray(req.body?.steps) ? req.body.steps : null;

  if (!steps) {
    return res.status(400).json({
      ok: false,
      error: "steps must be an array",
    });
  }

  if (steps.length === 0 || steps.length > 20) {
    return res.status(400).json({
      ok: false,
      error: "steps length must be between 1 and 20",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const seenOrders = new Set<number>();
    const seenKeys = new Set<string>();

    for (const rawStep of steps) {
    const stepKey = String(rawStep.step_key || "").trim();
    const stepOrder = Number(rawStep.step_order);

    if (seenKeys.has(stepKey)) {
        throw new Error(`step_key duplicado: ${stepKey}`);
    }

    if (seenOrders.has(stepOrder)) {
        throw new Error(`step_order duplicado: ${stepOrder}`);
    }

    seenKeys.add(stepKey);
    seenOrders.add(stepOrder);
    }

    for (const rawStep of steps) {
      const stepKey = String(rawStep.step_key || "").trim();
      const prompt = String(rawStep.prompt || "").trim();
      const expectedType = String(rawStep.expected_type || "text").trim();
      const stepOrder = Number(rawStep.step_order);
      const required = typeof rawStep.required === "boolean" ? rawStep.required : true;
      const enabled = typeof rawStep.enabled === "boolean" ? rawStep.enabled : true;

      if (!stepKey || stepKey.length > 80) {
        throw new Error("Invalid step_key");
      }

      if (!prompt || prompt.length > 1000) {
        throw new Error(`Invalid prompt for step ${stepKey}`);
      }

      if (!Number.isInteger(stepOrder) || stepOrder < 1 || stepOrder > 100) {
        throw new Error(`Invalid step_order for step ${stepKey}`);
      }

      if (!VALID_EXPECTED_TYPES.has(expectedType)) {
        throw new Error(`Invalid expected_type for step ${stepKey}`);
      }

      await client.query(
        `
        INSERT INTO appointment_booking_flows (
          tenant_id,
          channel,
          step_key,
          step_order,
          prompt,
          expected_type,
          required,
          enabled,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          'voice',
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          NOW(),
          NOW()
        )
        ON CONFLICT (tenant_id, channel, step_key)
        DO UPDATE SET
          step_order = EXCLUDED.step_order,
          prompt = EXCLUDED.prompt,
          expected_type = EXCLUDED.expected_type,
          required = EXCLUDED.required,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
        `,
        [
          tenantId,
          stepKey,
          stepOrder,
          prompt,
          expectedType,
          required,
          enabled,
        ]
      );
    }

    await client.query("COMMIT");

    const { rows } = await pool.query(
      `
      SELECT
        id,
        tenant_id,
        channel,
        step_key,
        step_order,
        prompt,
        expected_type,
        required,
        enabled,
        created_at,
        updated_at
      FROM appointment_booking_flows
      WHERE tenant_id = $1
        AND channel = 'voice'
      ORDER BY step_order ASC, created_at ASC
      `,
      [tenantId]
    );

    return res.json({
      ok: true,
      steps: rows,
    });
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("❌ [appointment-booking-flow][POST]", err);

    return res.status(400).json({
      ok: false,
      error: err?.message || "Invalid booking flow",
    });
  } finally {
    client.release();
  }
});

export default router;