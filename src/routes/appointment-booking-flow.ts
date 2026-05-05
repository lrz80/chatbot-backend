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

function normalizeTranslationsObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, rawValue]) => [String(key).trim(), String(rawValue ?? "").trim()])
      .filter(([key, text]) => key && text)
  );
}

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
        retry_prompt,
        prompt_translations,
        retry_prompt_translations,
        validation_config,
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
      const retryPrompt = String(rawStep.retry_prompt || "").trim();
      const promptTranslations = normalizeTranslationsObject(rawStep.prompt_translations);
      const retryPromptTranslations = normalizeTranslationsObject(rawStep.retry_prompt_translations);
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

      for (const [locale, text] of Object.entries(promptTranslations)) {
        if (!locale || text.length > 2000) {
          throw new Error(`Invalid prompt_translations for step ${stepKey}`);
        }
      }

      for (const [locale, text] of Object.entries(retryPromptTranslations)) {
        if (!locale || text.length > 2000) {
          throw new Error(`Invalid retry_prompt_translations for step ${stepKey}`);
        }
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
          retry_prompt,
          prompt_translations,
          retry_prompt_translations,
          validation_config,
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
          $8,
          $9,
          $10,
          $11,
          NOW(),
          NOW()
      )
      ON CONFLICT (tenant_id, channel, step_key)
      DO UPDATE SET
          step_order = EXCLUDED.step_order,
          prompt = EXCLUDED.prompt,
          retry_prompt = EXCLUDED.retry_prompt,
          prompt_translations = EXCLUDED.prompt_translations,
          retry_prompt_translations = EXCLUDED.retry_prompt_translations,
          validation_config = EXCLUDED.validation_config,
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
            retryPrompt || null,
            Object.keys(promptTranslations).length ? promptTranslations : null,
            Object.keys(retryPromptTranslations).length ? retryPromptTranslations : null,
            rawStep.validation_config || {},
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
        retry_prompt,
        prompt_translations,
        retry_prompt_translations,
        validation_config,
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