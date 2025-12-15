// src/services/bookingSession.ts
import pool from "../lib/db";
import type { BookingChannel } from "./booking";

export type BookingState = "WAITING_DATETIME" | "WAITING_CONTACT";

export interface BookingSession {
  id: string;
  tenant_id: string;
  channel: BookingChannel;
  contact: string;
  state: BookingState;
  desired_start_time: string | null; // timestamptz ISO
  desired_end_time: string | null;
  service_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Obtiene la sesión activa del contacto o la crea.
 * - NO pisa datos si ya existe.
 */
export async function getOrCreateBookingSession(params: {
  tenantId: string;
  channel: BookingChannel;
  contact: string;
}): Promise<BookingSession> {
  const { tenantId, channel, contact } = params;

  const { rows } = await pool.query<BookingSession>(
    `
    INSERT INTO booking_sessions (tenant_id, channel, contact, state)
    VALUES ($1, $2, $3, 'WAITING_DATETIME')
    ON CONFLICT (tenant_id, channel, contact)
    DO UPDATE SET updated_at = NOW()
    RETURNING *
    `,
    [tenantId, channel, contact]
  );

  return rows[0];
}

/**
 * Actualiza campos de la sesión (parcial).
 * Útil para avanzar state y guardar desired_start_time, datos cliente, etc.
 */
export async function updateBookingSession(params: {
  tenantId: string;
  channel: BookingChannel;
  contact: string;
  patch: Partial<{
    state: BookingState;
    desired_start_time: Date | null;
    desired_end_time: Date | null;
    service_id: string | null;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
  }>;
}): Promise<BookingSession | null> {
  const { tenantId, channel, contact, patch } = params;

  // construimos SET dinámico
  const set: string[] = [];
  const values: any[] = [];
  let i = 1;

  const push = (col: string, val: any) => {
    set.push(`${col} = $${i++}`);
    values.push(val);
  };

  if (patch.state) push("state", patch.state);

  if (patch.desired_start_time !== undefined)
    push("desired_start_time", patch.desired_start_time ? patch.desired_start_time.toISOString() : null);

  if (patch.desired_end_time !== undefined)
    push("desired_end_time", patch.desired_end_time ? patch.desired_end_time.toISOString() : null);

  if (patch.service_id !== undefined) push("service_id", patch.service_id);
  if (patch.customer_name !== undefined) push("customer_name", patch.customer_name);
  if (patch.customer_email !== undefined) push("customer_email", patch.customer_email);
  if (patch.customer_phone !== undefined) push("customer_phone", patch.customer_phone);

  // siempre tocamos updated_at
  push("updated_at", new Date().toISOString());

  values.push(tenantId, channel, contact);

  const { rows } = await pool.query<BookingSession>(
    `
    UPDATE booking_sessions
    SET ${set.join(", ")}
    WHERE tenant_id = $${i++} AND channel = $${i++} AND contact = $${i++}
    RETURNING *
    `,
    values
  );

  return rows[0] ?? null;
}

/**
 * Cierra sesión (la elimina). En Fase 1 es lo más simple.
 * En el futuro se puede guardar historial en otra tabla.
 */
export async function closeBookingSession(params: {
  tenantId: string;
  channel: BookingChannel;
  contact: string;
}): Promise<void> {
  const { tenantId, channel, contact } = params;

  await pool.query(
    `DELETE FROM booking_sessions WHERE tenant_id = $1 AND channel = $2 AND contact = $3`,
    [tenantId, channel, contact]
  );
}

/**
 * Obtiene la sesión actual si existe, sin crearla.
 */
export async function getBookingSession(params: {
  tenantId: string;
  channel: BookingChannel;
  contact: string;
}): Promise<BookingSession | null> {
  const { tenantId, channel, contact } = params;

  const { rows } = await pool.query<BookingSession>(
    `SELECT * FROM booking_sessions WHERE tenant_id = $1 AND channel = $2 AND contact = $3 LIMIT 1`,
    [tenantId, channel, contact]
  );

  return rows[0] ?? null;
}
