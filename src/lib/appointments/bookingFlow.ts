import pool from "../db";
import { canUseChannel } from "../features";
import { googleFreeBusy, googleCreateEvent } from "../../services/googleCalendar";

type BookingCtx = {
  booking?: {
    step?: "idle" | "ask_datetime" | "confirm";
    start_time?: string; // ISO
    end_time?: string;   // ISO
    timeZone?: string;
    customer_name?: string;
  };
};

async function loadBookingTerms(tenantId: string): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `SELECT hints FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const hints = rows[0]?.hints;
    const obj = typeof hints === "string" ? JSON.parse(hints) : (hints || {});
    const terms = Array.isArray(obj?.booking_terms) ? obj.booking_terms : null;
    if (terms && terms.length) return terms.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean);
  } catch {}
  // defaults genéricos multi-nicho
  return ["cita","consulta","reservar","reserva","turno","agendar","appointment","book","booking","schedule"];
}

function matchesBookingIntent(text: string, terms: string[]) {
  const t = String(text || "").toLowerCase();
  return terms.some(term => term && new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t));
}

/**
 * MVP: Pedimos fecha/hora en formato explícito:
 *   YYYY-MM-DD HH:mm (hora local del negocio)
 * Ej: 2026-01-17 15:00
 */
function parseDateTimeExplicit(input: string, timeZone: string) {
  const m = String(input || "").trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (!m) return null;

  const date = m[1];
  const hhmm = m[2];

  // Construimos ISO local con offset fijo -05:00 (MVP).
  // Luego lo perfeccionamos con TZ real si quieres.
  const startISO = `${date}T${hhmm}:00-05:00`;

  // 30 min default
  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const endISO = end.toISOString(); // ojo: esto queda en Z, pero Google acepta ISO.
  // Para mantener simetría, devolvemos startISO como quedó.
  return { startISO, endISO, timeZone };
}

async function insertAppointment(opts: {
  tenantId: string;
  channel: string;
  customer_name: string;
  customer_phone?: string | null;
  customer_email?: string | null;
  start_time: string;
  end_time: string;
  google_event_id?: string | null;
  google_event_link?: string | null;
}) {
  const {
    tenantId,
    channel,
    customer_name,
    customer_phone,
    customer_email,
    start_time,
    end_time,
    google_event_id,
    google_event_link,
  } = opts;

  const { rows } = await pool.query(
    `
    INSERT INTO appointments (
      tenant_id, service_id, channel, customer_name, customer_phone, customer_email,
      start_time, end_time, status, google_event_id, google_event_link
    )
    VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
    RETURNING id
    `,
    [
      tenantId,
      channel,
      customer_name,
      customer_phone || null,
      customer_email || null,
      start_time,
      end_time,
      google_event_id || null,
      google_event_link || null,
    ]
  );

  return rows[0]?.id || null;
}

async function bookInGoogle(opts: {
  tenantId: string;
  customer_name: string;
  startISO: string;
  endISO: string;
  timeZone: string;
}) {
  const { tenantId, customer_name, startISO, endISO, timeZone } = opts;

  // 1) freebusy
  const fb = await googleFreeBusy({
    tenantId,
    timeMin: startISO,
    timeMax: endISO,
    calendarId: "primary",
  });

  const busy = fb?.calendars?.primary?.busy || [];
  if (busy.length > 0) {
    return { ok: false as const, error: "SLOT_BUSY" as const, busy };
  }

  // 2) create event
  const event = await googleCreateEvent({
    tenantId,
    calendarId: "primary",
    summary: `Reserva: ${customer_name}`,
    description: `Agendado por Aamy\nCliente: ${customer_name}`,
    startISO,
    endISO,
    timeZone,
  });

  return {
    ok: true as const,
    event_id: event?.id || null,
    htmlLink: event?.htmlLink || null,
  };
}

/**
 * Booking flow MVP (sin LLM):
 * - Si detecta intención de cita -> pide fecha/hora (formato explícito)
 * - Si usuario manda fecha/hora -> confirma y agenda
 */
export async function bookingFlowMvp(opts: {
  tenantId: string;
  canal: string; // "whatsapp"
  contacto: string;
  idioma: "es" | "en";
  userText: string;
  ctx: any; // convoCtx (object)
}): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const { tenantId, canal, contacto, idioma, userText } = opts;

  const ctx = (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as BookingCtx) : {};
  const booking = ctx.booking || { step: "idle" as const };
  const timeZone = booking.timeZone || "America/New_York";

  const terms = await loadBookingTerms(tenantId);
  const wantsBooking = matchesBookingIntent(userText, terms);

  // Gate de canal (desde dashboard)
  const gate = await canUseChannel(tenantId, "google_calendar" as any);
  if (!gate.settings_enabled) {
    // Si el usuario pide cita pero canal está apagado, respondemos y salimos
    if (wantsBooking) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Appointments are currently disabled for this business."
          : "Las citas están desactivadas en este momento para este negocio.",
      };
    }
    return { handled: false };
  }

  // 1) Arranque: detecta intención y pide fecha/hora
  if (booking.step === "idle") {
    if (!wantsBooking) return { handled: false };

    return {
      handled: true,
      reply: idioma === "en"
        ? "Sure. Send the date and time in this format: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
        : "Perfecto. Envíame la fecha y hora en este formato: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00).",
      ctxPatch: {
        booking: { step: "ask_datetime", timeZone },
      },
    };
  }

  // 2) Esperando fecha/hora
  if (booking.step === "ask_datetime") {
    const parsed = parseDateTimeExplicit(userText, timeZone);
    if (!parsed) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "I couldn’t read that. Please use: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
          : "No pude leer esa fecha/hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
      };
    }

    // Guardamos y pedimos confirmación
    return {
      handled: true,
      reply: idioma === "en"
        ? `Confirm booking for ${parsed.startISO}? Reply YES to confirm or NO to cancel.`
        : `Confirmo: ${parsed.startISO}. Responde SI para confirmar o NO para cancelar.`,
      ctxPatch: {
        booking: {
          step: "confirm",
          start_time: parsed.startISO,
          end_time: parsed.endISO,
          timeZone,
        },
      },
    };
  }

  // 3) Confirmación SI/NO
  if (booking.step === "confirm") {
    const t = String(userText || "").trim().toLowerCase();
    const yes = /^(si|sí|yes|y)$/i.test(t);
    const no = /^(no|n)$/i.test(t);

    if (!yes && !no) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Please reply YES to confirm or NO to cancel."
          : "Responde SI para confirmar o NO para cancelar.",
        ctxPatch: { booking },
      };
    }

    if (no) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Cancelled. If you want, tell me another date/time."
          : "Listo, cancelado. Si quieres, dime otra fecha/hora.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }

    // YES -> agenda en Google + guarda en DB
    const customer_name = "Cliente"; // MVP: luego lo sacamos de clientes o lo pedimos
    const startISO = booking.start_time!;
    const endISO = booking.end_time!;

    const g = await bookInGoogle({
      tenantId,
      customer_name,
      startISO,
      endISO,
      timeZone,
    });

    if (!g.ok) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "That slot is not available. Send another date/time (YYYY-MM-DD HH:mm)."
          : "Ese horario no está disponible. Envíame otra fecha/hora (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { step: "ask_datetime", timeZone } },
      };
    }

    const apptId = await insertAppointment({
      tenantId,
      channel: canal,
      customer_name,
      customer_phone: contacto,
      start_time: startISO,
      end_time: endISO,
      google_event_id: g.event_id,
      google_event_link: g.htmlLink,
    });

    return {
      handled: true,
      reply: idioma === "en"
        ? `Booked. Event created. ${g.htmlLink || ""}`.trim()
        : `Listo, tu cita fue agendada. ${g.htmlLink || ""}`.trim(),
      ctxPatch: { booking: { step: "idle" }, last_appointment_id: apptId },
    };
  }

  return { handled: false };
}
