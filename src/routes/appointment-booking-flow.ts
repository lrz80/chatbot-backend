//src/routes/appointment-booking-flow.ts
import { Router } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";
import { clearVoiceBookingFlowCache } from "../lib/voice/handleVoiceBookingTurn";

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

    const normalizedSteps: Array<{
      step_key: string;
      step_order: number;
      prompt: string;
      retry_prompt: string | null;
      prompt_translations: Record<string, string>;
      retry_prompt_translations: Record<string, string>;
      validation_config: Record<string, unknown>;
      expected_type: string;
      required: boolean;
      enabled: boolean;
    }> = steps.map((rawStep: any, index: number) => {
      const stepKey = String(rawStep.step_key || "").trim();
      const prompt = String(rawStep.prompt || "").trim();
      const retryPrompt = String(rawStep.retry_prompt || "").trim();
      const promptTranslations = normalizeTranslationsObject(rawStep.prompt_translations);
      const retryPromptTranslations = normalizeTranslationsObject(rawStep.retry_prompt_translations);
      const expectedType = String(rawStep.expected_type || "text").trim();
      const required = typeof rawStep.required === "boolean" ? rawStep.required : true;
      const enabled = typeof rawStep.enabled === "boolean" ? rawStep.enabled : true;
      const validationConfig =
        rawStep.validation_config && typeof rawStep.validation_config === "object"
          ? (rawStep.validation_config as Record<string, unknown>)
          : {};

      return {
        step_key: stepKey,
        step_order: index + 1,
        prompt,
        retry_prompt: retryPrompt || null,
        prompt_translations: promptTranslations,
        retry_prompt_translations: retryPromptTranslations,
        validation_config: validationConfig,
        expected_type: expectedType,
        required,
        enabled,
      };
    });

    const seenKeys = new Set<string>();

    for (const step of normalizedSteps) {
      if (!step.step_key || step.step_key.length > 80) {
        throw new Error("Invalid step_key");
      }

      if (seenKeys.has(step.step_key)) {
        throw new Error(`step_key duplicado: ${step.step_key}`);
      }

      seenKeys.add(step.step_key);

      if (!step.prompt || step.prompt.length > 1000) {
        throw new Error(`Invalid prompt for step ${step.step_key}`);
      }

      for (const [locale, text] of Object.entries(step.prompt_translations)) {
        if (!locale || text.length > 2000) {
          throw new Error(`Invalid prompt_translations for step ${step.step_key}`);
        }
      }

      for (const [locale, text] of Object.entries(step.retry_prompt_translations)) {
        if (!locale || text.length > 2000) {
          throw new Error(`Invalid retry_prompt_translations for step ${step.step_key}`);
        }
      }

      if (!Number.isInteger(step.step_order) || step.step_order < 1 || step.step_order > 100) {
        throw new Error(`Invalid step_order for step ${step.step_key}`);
      }

      if (!VALID_EXPECTED_TYPES.has(step.expected_type)) {
        throw new Error(`Invalid expected_type for step ${step.step_key}`);
      }
    }

    await client.query(
      `
      DELETE FROM appointment_booking_flows
      WHERE tenant_id = $1
        AND channel = 'voice'
      `,
      [tenantId]
    );

    for (const step of normalizedSteps) {
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
        `,
        [
          tenantId,
          step.step_key,
          step.step_order,
          step.prompt,
          step.retry_prompt,
          Object.keys(step.prompt_translations).length ? step.prompt_translations : null,
          Object.keys(step.retry_prompt_translations).length ? step.retry_prompt_translations : null,
          step.validation_config,
          step.expected_type,
          step.required,
          step.enabled,
        ]
      );
    }

    await client.query("COMMIT");
    clearVoiceBookingFlowCache(tenantId);

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