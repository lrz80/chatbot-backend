// src/lib/appointments/bookingFlow.ts
import pool from "../db";
import { googleFreeBusy, googleCreateEvent } from "../../services/googleCalendar";
import { canUseChannel } from "../features";

type BookingCtx = {
  booking?: {
    step?: "idle" | "ask_datetime" | "confirm";
    start_time?: string; // ISO
    end_time?: string;   // ISO
    timeZone?: string;
    customer_name?: string;
  };
};

async function isGoogleConnected(tenantId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM calendar_integrations
        WHERE tenant_id = $1
          AND provider = 'google'
          AND status = 'connected'
        LIMIT 1`,
      [tenantId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

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

function wantsToChangeTopic(text: string) {
  const t = String(text || "").toLowerCase();

  return (
    /\b(precio|precios|cuanto|cuánto|tarifa|costo|costos)\b/i.test(t) ||
    /\b(price|prices|pricing|cost|costs|rate|rates|fee|fees)\b/i.test(t) ||
    /\b(how\s*much|what'?s\s+the\s+price|what\s+is\s+the\s+price)\b/i.test(t) ||
    /\b(horario|horarios|hours|open|close|abren|cierran)\b/i.test(t) ||
    /\b(ubicacion|ubicación|direccion|dirección|address|where)\b/i.test(t) ||
    /\b(info|informacion|información|details|mas informacion|más información)\b/i.test(t) ||
    /\b(como funciona|cómo funciona|how does it work|how it works)\b/i.test(t) ||   // ✅ NUEVO
    /\b(cancelar|cancela|olvida|stop|salir|exit)\b/i.test(t)
  );
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
    VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, 'confirmed', $8, $9)
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
  console.log("📅 [BOOKING] freebusy", {
    tenantId,
    timeMin: startISO,
    timeMax: endISO,
    busyCount: busy.length,
  });

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
  bookingLink?: string | null; // ✅ viene del prompt
  messageId?: string | null; // ✅ NUEVO
}): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const { tenantId, canal, contacto, idioma, userText } = opts;

  const messageId = opts.messageId ? String(opts.messageId) : null;

  const ctx = (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as BookingCtx) : {};
  const booking = ctx.booking || { step: "idle" as const };
  const timeZone = booking.timeZone || "America/New_York";

  // ✅ POST-BOOKING GUARD: si ya quedó agendado y el usuario manda "SI" otra vez,
  // respondemos con el link existente (sin pasar por SM/LLM)
  const t0 = String(userText || "").trim().toLowerCase();
  const isYesNo = /^(si|sí|yes|y|no|n)$/i.test(t0);

  if ((booking.step === "idle") && isYesNo) {
    const lastApptId = (opts.ctx && typeof opts.ctx === "object")
      ? (opts.ctx as any)?.last_appointment_id
      : null;

    if (lastApptId) {
      const { rows } = await pool.query(
        `SELECT google_event_link
           FROM appointments
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1`,
        [lastApptId, tenantId]
      );

      const link = rows[0]?.google_event_link || "";

      return {
        handled: true,
        reply: idioma === "en"
          ? `Already booked. ${link}`.trim()
          : `Ya quedó agendado. ${link}`.trim(),
        ctxPatch: { booking: { step: "idle" } },
      };
    }
  }

  const terms = await loadBookingTerms(tenantId);
  const wantsBooking = matchesBookingIntent(userText, terms);

  const gate = await canUseChannel(tenantId, "google_calendar");
  const bookingEnabled = !!gate.settings_enabled;
  console.log("📅 [BOOKING] gate:", { settings_enabled: gate.settings_enabled, plan_enabled: gate.plan_enabled, enabled: gate.enabled });

  const googleConnected = await isGoogleConnected(tenantId);

  const bookingLink = opts.bookingLink ? String(opts.bookingLink).trim() : null;

  // 1) Si el tenant apagó agendamiento: bloquea todo
  if (!bookingEnabled) {
    if (wantsBooking || booking?.step !== "idle") {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Scheduling is currently disabled for this business."
          : "El agendamiento está desactivado en este momento para este negocio.",
        ctxPatch: { booking: { step: "idle" } },
    };
  }
  return { handled: false };
}

// 2) Si hay link, responde con el link (y NO uses Google)
if (wantsBooking && bookingLink) {
  return {
    handled: true,
    reply: idioma === "en"
      ? `You can book here: ${bookingLink}`
      : `Puedes agendar aquí: ${bookingLink}`,
    ctxPatch: { booking: { step: "idle" } },
  };
}

// 3) Si NO hay link y Google NO está conectado: no inicies flujo
if (wantsBooking && !bookingLink && !googleConnected) {
  return {
    handled: true,
    reply: idioma === "en"
      ? "Scheduling isn’t available for this business right now."
      : "El agendamiento no está disponible en este momento para este negocio.",
    ctxPatch: { booking: { step: "idle" } },
  };
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
    // ✅ ESCAPE: si el usuario cambió de tema, salimos del flow
    if (wantsToChangeTopic(userText)) {
        return {
        handled: false,                 // deja que el SM/LLM responda
        ctxPatch: { booking: { step: "idle" } }, // resetea el wizard
        };
    }

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

    // ✅ DEDUPE: si Twilio reintenta el mismo inbound o el usuario manda "SI" repetido
    // Usamos interactions como lock atómico (ya tienes UNIQUE tenant_id+canal+message_id).
    if (yes && messageId) {
      const lockId = `booking:${messageId}`;
      const ins = await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
        RETURNING 1`,
        [tenantId, canal, lockId]
      );

      if (ins.rowCount === 0) {
        // Ya se procesó este "SI" antes → devuelve el link si existe en DB
        const startISO = booking.start_time!;
        const { rows } = await pool.query(
        `SELECT google_event_link
            FROM appointments
            WHERE tenant_id=$1
            AND customer_phone=$2
            AND start_time=$3
            ORDER BY created_at DESC
            LIMIT 1`,
        [tenantId, contacto, startISO]
        );

        const link = rows[0]?.google_event_link || "";
        return {
        handled: true,
        reply: idioma === "en"
            ? `Already booked. ${link}`.trim()
            : `Ya quedó agendado. ${link}`.trim(),
        ctxPatch: { booking: { step: "idle" } },
        };
      }
    }

    if (!googleConnected) {
      return {
        handled: true,
        reply: idioma === "en"
        ? "Scheduling isn’t available for this business right now."
        : "El agendamiento no está disponible en este momento para este negocio.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }

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
        : `Listo, quedó agendado. Aquí está el enlace: ${g.htmlLink || ""}`.trim(),
      ctxPatch: { booking: { step: "idle" }, last_appointment_id: apptId },
    };
  }

  return { handled: false };
}
