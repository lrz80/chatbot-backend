// src/integrations/googleCalendar.ts
import fetch from "node-fetch";

interface ExternalCalendar {
  id: string;
  tenant_id: string;
  provider: string;              // 'google', 'glofox', etc.
  external_calendar_id: string;  // ID de Google Calendar u otro
  display_name?: string | null;
}

interface Appointment {
  id: string;
  tenant_id: string;
  service_id?: string | null;
  channel: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_email?: string | null;
  start_time: string; // ISO
  end_time: string;   // ISO
}

export async function sendAppointmentToGoogleViaZapier(
  appointment: Appointment,
  calendar: ExternalCalendar
) {
  const url = process.env.ZAPIER_BOOKINGS_WEBHOOK_URL;
  if (!url) {
    console.warn("[BOOKING] ZAPIER_BOOKINGS_WEBHOOK_URL no está definido, no se envía a Zapier.");
    return;
  }

  const payload = {
    tenantId: appointment.tenant_id,
    calendarProvider: calendar.provider,           // 'google'
    externalCalendarId: calendar.external_calendar_id,
    appointmentId: appointment.id,
    serviceId: appointment.service_id,
    channel: appointment.channel,
    customerName: appointment.customer_name,
    customerPhone: appointment.customer_phone,
    customerEmail: appointment.customer_email,
    startTime: appointment.start_time,
    endTime: appointment.end_time,
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("[BOOKING] Cita enviada a Zapier/Google correctamente.");
  } catch (err) {
    console.error("[BOOKING] Error enviando cita a Zapier/Google:", err);
  }
}
