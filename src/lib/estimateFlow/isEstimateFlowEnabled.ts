// backend/src/lib/estimateFlow/isEstimateFlowEnabled.ts

import type { Pool } from "pg";

export async function isEstimateFlowEnabled(
  pool: Pool,
  tenantId: string
): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `
      SELECT estimate_flow_enabled
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    return Boolean(rows?.[0]?.estimate_flow_enabled);
  } catch (e) {
    console.warn("[estimateFlow] isEstimateFlowEnabled error:", e);
    return false;
  }
}