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

  if (!state) return { ok: false, reason: "missing_state" };
  if (state.step !== "ready_to_schedule" && state.step !== "scheduled") {
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
      tipo_trabajo,
      preferred_date,
      preferred_time,
      calendar_event_id,
      calendar_event_link
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (tenant_id, canal, contacto)
    DO UPDATE SET
      nombre = EXCLUDED.nombre,
      telefono = EXCLUDED.telefono,
      direccion = EXCLUDED.direccion,
      tipo_trabajo = EXCLUDED.tipo_trabajo,
      preferred_date = EXCLUDED.preferred_date,
      preferred_time = EXCLUDED.preferred_time,
      calendar_event_id = EXCLUDED.calendar_event_id,
      calendar_event_link = EXCLUDED.calendar_event_link
    `,
    [
      tenantId,
      canal,
      contacto,
      state.name || null,
      state.phone || null,
      state.address || null,
      state.jobType || null,
      state.preferredDate || null,
      state.preferredTime || null,
      state.calendarEventId || null,
      state.calendarEventLink || null,
    ]
  );

  return { ok: true };
}