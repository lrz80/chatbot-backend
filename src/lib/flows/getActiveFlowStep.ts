// lib/flows/getActiveFlowStep.ts
import pool from "../../lib/db";

export async function getActiveFlowStep({
  tenantId,
  canal,
  flowSlug,
  stepKey,
  lang,
}: {
  tenantId: string;
  canal: string;
  flowSlug: string;
  stepKey: string;
  lang: "es" | "en";
}) {
  const res = await pool.query(
    `
    SELECT
      f.slug AS flow_slug,
      s.step_key,
      CASE WHEN $5 = 'en' THEN s.prompt_en ELSE s.prompt_es END AS prompt,
      s.expected_type,
      s.options,
      s.next_step,
      s.is_terminal
    FROM flow_steps s
    JOIN flows f ON f.id = s.flow_id
    WHERE f.tenant_id = $1
      AND f.canal = $2
      AND f.slug = $3
      AND s.step_key = $4
      AND f.is_active = true
    LIMIT 1
    `,
    [tenantId, canal, flowSlug, stepKey, lang]
  );

  return res.rows[0] || null;
}
