// src/lib/appointments/cancelAppointment.ts
import pool from "../db";
import { googleDeleteEvent } from "../../services/googleCalendar";

// 👇 helper: calendarId por tenant, con fallback a "primary"
async function getTenantCalendarId(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `
    SELECT calendar_id
    FROM calendar_integrations
    WHERE tenant_id = $1
      AND provider = 'google'
      AND status = 'connected'
    LIMIT 1
    `,
    [tenantId]
  );

  return String(rows[0]?.calendar_id || "primary");
}

export async function cancelAppointmentById(args: {
  tenantId: string;
  appointmentId: string;
}) {
  const { tenantId, appointmentId } = args;

  // 1) Cargar cita (seguro por tenant)
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

  // 3) Resolver eventId de Google
  let googleEventId = String(appt.google_event_id || "").trim();
  const googleLink = String(appt.google_event_link || "").trim() || null;

  // Fallback: derivar eventId desde google_event_link si hace falta
  if (!googleEventId && googleLink && googleLink.includes("calendar/event")) {
    try {
      const url = new URL(googleLink);
      const eid = url.searchParams.get("eid"); // base64 "<eventId> <calendarId>"
      if (eid) {
        const decoded = Buffer.from(eid, "base64").toString("utf8");
        const [idFromLink] = decoded.split(" ");
        if (idFromLink) {
          googleEventId = idFromLink;
          console.log(
            "[cancelAppointmentById] eventId derivado desde google_event_link:",
            { eid, decoded, eventId: googleEventId }
          );
        }
      }
    } catch (e: any) {
      console.warn(
        "[cancelAppointmentById] No pude derivar eventId desde google_event_link:",
        e?.message
      );
    }
  }

  // 3b) Intentar borrar en Google, pero NUNCA salir antes de actualizar la DB
  let googleError: string | null = null;

  if (googleEventId) {
    try {
      const calendarId = await getTenantCalendarId(tenantId);

      await googleDeleteEvent({
        tenantId,
        calendarId,
        eventId: googleEventId,
      });
    } catch (e: any) {
      const msg = String(e?.message || "google_delete_failed");
      googleError = `CANCEL_GOOGLE_${msg}`;

      console.warn("[cancelAppointmentById] Error al borrar en Google:", msg);

      // Logueamos el error, pero NO hacemos return aquí
      await pool.query(
        `
        UPDATE appointments
           SET error_reason = $2,
               updated_at = NOW()
         WHERE id = $1 AND tenant_id = $3
        `,
        [appointmentId, googleError, tenantId]
      );
    }
  }

  // 4) Marcar SIEMPRE como cancelled en la DB
  const updateRes = await pool.query(
    `
    UPDATE appointments
      SET status = 'cancelled',
          updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
    RETURNING id, status
    `,
    [appointmentId, tenantId]
  );

  console.log("[CANCEL] DB updated", updateRes.rows[0]);

  return {
    ok: true as const,               // 👈 SIEMPRE true si la DB se actualizó
    canceled: true as const,
    google_event_link: googleLink,
    googleError,                     // 👈 solo para logging/monitoring
  };
}