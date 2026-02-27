//src/lib/appoinments/cancelAppointments.ts
import pool from "../db";
import { googleDeleteEvent } from "../../services/googleCalendar";

// 👇 NUEVO helper
async function getTenantCalendarId(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `
    SELECT calendar_id
    FROM google_calendar_accounts
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  // si no hay registro, fallback a "primary"
  return String(rows[0]?.calendar_id || "primary");
}

export async function cancelAppointmentById(args: {
  tenantId: string;
  appointmentId: string;
}) {
  const { tenantId, appointmentId } = args;

  // 1) Cargar cita (segura por tenant)
  const { rows } = await pool.query(
    `
    SELECT id, tenant_id, status, google_event_id, google_event_link
    FROM appointments
    WHERE id = $1 AND tenant_id = $2
    LIMIT 1
    `,
    [appointmentId, tenantId]
  );

  const appt = rows[0];
  if (!appt) {
    return { ok: false, error: "APPOINTMENT_NOT_FOUND" as const };
  }

  // 2) Idempotencia
  if (appt.status === "canceled" || appt.status === "cancelled") {
    return { ok: true, already: true as const };
  }

  // 3) Si hay google_event_id -> borrar en Google primero
  const googleEventId = String(appt.google_event_id || "").trim();
  const googleLink = String(appt.google_event_link || "").trim() || null;

  if (googleEventId) {
    try {
      // 👇 resolvemos el mismo calendarId donde se creó la cita
      const calendarId = await getTenantCalendarId(tenantId);

      await googleDeleteEvent({
        tenantId,
        calendarId,
        eventId: googleEventId,
      });
    } catch (e: any) {
      const msg = String(e?.message || "google_delete_failed");
      await pool.query(
        `
        UPDATE appointments
           SET error_reason = $2,
               updated_at = NOW()
         WHERE id = $1 AND tenant_id = $3
        `,
        [appointmentId, `CANCEL_GOOGLE_${msg}`, tenantId]
      );

      return { ok: false, error: "GOOGLE_DELETE_FAILED" as const, detail: msg };
    }
  }

  // 4) Marcar canceled
  await pool.query(
    `
    UPDATE appointments
       SET status = 'cancelled',
           error_reason = NULL,
           updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2
    `,
    [appointmentId, tenantId]
  );

  return { ok: true, canceled: true as const, google_event_link: googleLink };
}
