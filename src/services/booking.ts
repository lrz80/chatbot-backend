// src/services/booking.ts
import pool from "../lib/db";
import { sendAppointmentToGoogleViaZapier } from "../integrations/googleCalendar";

export type BookingChannel = "whatsapp" | "facebook" | "instagram" | "voice";

export interface CreateAppointmentInput {
  tenantId: string;
  serviceId?: string;               // opcional, podemos resolver un servicio por defecto
  channel: BookingChannel;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  startTime: Date;                  // fecha/hora ya elegida por el bot
  durationMin?: number;             // si no la pasas, se usa la del servicio o 60min
}

export async function createAppointment(input: CreateAppointmentInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Resolver servicio (si no viene serviceId, usar el primero activo del tenant)
    let serviceId = input.serviceId ?? null;
    let durationMin = input.durationMin ?? 60;

    if (!serviceId) {
      const { rows } = await client.query(
        `SELECT id, duration_min
         FROM services
         WHERE tenant_id = $1 AND active = TRUE
         ORDER BY created_at ASC
         LIMIT 1`,
        [input.tenantId]
      );

      if (rows[0]) {
        serviceId = rows[0].id;
        durationMin = rows[0].duration_min ?? durationMin;
      }
    } else if (!input.durationMin) {
      // si viene serviceId pero no durationMin, intentamos leerlo
      const { rows } = await client.query(
        `SELECT duration_min
         FROM services
         WHERE id = $1 AND tenant_id = $2`,
        [serviceId, input.tenantId]
      );
      if (rows[0]?.duration_min) {
        durationMin = rows[0].duration_min;
      }
    }

    const start = input.startTime;
    const end = new Date(start.getTime() + durationMin * 60 * 1000);

    // 2) Insertar appointment en la base de datos
    const { rows: apptRows } = await client.query(
      `INSERT INTO appointments
        (tenant_id, service_id, channel, customer_name, customer_phone, customer_email,
         start_time, end_time, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed')
       RETURNING *`,
      [
        input.tenantId,
        serviceId,
        input.channel,
        input.customerName ?? null,
        input.customerPhone ?? null,
        input.customerEmail ?? null,
        start.toISOString(),
        end.toISOString(),
      ]
    );

    const appointment = apptRows[0];

    // 3) Sincronizar con calendarios externos (Google en Fase 1)
    await syncAppointmentToExternalCalendars(client, appointment);

    await client.query("COMMIT");
    return appointment;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[BOOKING] Error creando cita:", err);
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------
// Función interna: sincronización con calendarios
// --------------------------------------------
async function syncAppointmentToExternalCalendars(client: any, appointment: any) {
  // Buscar el calendario por defecto del tenant
  const { rows: calendars } = await client.query(
    `SELECT *
     FROM external_calendars
     WHERE tenant_id = $1 AND is_default = TRUE`,
    [appointment.tenant_id]
  );

  if (!calendars.length) {
    console.log("[BOOKING] Tenant sin calendarios externos configurados, no se sincroniza.");
    return;
  }

  for (const cal of calendars) {
    if (cal.provider === "google") {
      await sendAppointmentToGoogleViaZapier(appointment, cal);
    }

    // FUTURO:
    // if (cal.provider === "glofox") { ... }
    // if (cal.provider === "booksy") { ... }
  }
}
