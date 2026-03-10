// backend/src/lib/estimateFlow/saveEstimateRequest.ts

import type { Pool } from "pg";
import type { EstimateFlowState } from "./types";

type SaveEstimateRequestArgs = {
  pool: Pool;
  tenantId: string;
  canal: string;
  contacto: string;
  state: EstimateFlowState;
};

export async function saveEstimateRequest(args: SaveEstimateRequestArgs) {
  const { pool, tenantId, canal, contacto, state } = args;

  if (!state?.active) return { ok: false, reason: "inactive_state" };
  if (state.step !== "ready_to_schedule") {
    return { ok: false, reason: "not_ready" };
  }

  await pool.query(
    `
    INSERT INTO estimate_requests (
      tenant_id,
      canal,
      contacto,
      nombre,
      telefono,
      direccion,
      tipo_trabajo
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      tenantId,
      canal,
      contacto,
      state.name || null,
      state.phone || null,
      state.address || null,
      state.jobType || null,
    ]
  );

  return { ok: true };
}