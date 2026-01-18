// src/lib/appointments/bookingFlow.ts
import pool from "../db";
import { googleFreeBusy, googleCreateEvent } from "../../services/googleCalendar";
import { canUseChannel } from "../features";
import { DateTime } from "luxon";

type BookingCtx = {
  booking?: {
    step?: "idle" | "ask_all" | "ask_name" | "ask_email" | "ask_datetime" | "confirm";
    start_time?: string;
    end_time?: string;
    timeZone?: string;
    name?: string;
    email?: string;
  };
};

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function extractDateTimeToken(input: string): string | null {
  const m = String(input || "").match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
  return m?.[1] || null;
}

function removeOnce(haystack: string, needle: string) {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return haystack;
  return (haystack.slice(0, idx) + " " + haystack.slice(idx + needle.length)).trim();
}

function cleanNameCandidate(raw: string): string {
  return String(raw || "")
    .replace(/[,\|;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ✅ Parser “todo en uno”: "Juan Perez, juan@email.com, 2026-01-21 14:00"
function parseAllInOne(input: string, timeZone: string): {
  name: string | null;
  email: string | null;
  startISO: string | null;
  endISO: string | null;
} {
  const raw = String(input || "").trim();

  // 1) Email
  const email = raw.match(EMAIL_REGEX)?.[0]?.toLowerCase() || null;

  // 2) Fecha token (YYYY-MM-DD HH:mm) en cualquier parte del mensaje
  const dtToken = extractDateTimeToken(raw);
  const dtParsed = dtToken ? parseDateTimeExplicit(dtToken, timeZone) : null;

  const startISO = dtParsed?.startISO || null;
  const endISO = dtParsed?.endISO || null;

  // 3) Nombre: resto del texto sin email ni fecha
  let nameCandidate = raw;
  if (email) nameCandidate = removeOnce(nameCandidate, email);
  if (dtToken) nameCandidate = removeOnce(nameCandidate, dtToken);

  nameCandidate = cleanNameCandidate(nameCandidate);

  // Quita palabras “de relleno” comunes (opcional pero útil)
  nameCandidate = nameCandidate
    .replace(/\b(mi nombre es|soy|me llamo|name is|i am)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const name = nameCandidate ? parseFullName(nameCandidate) : null;

  return { name, email, startISO, endISO };
}

function parseEmail(input: string) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  // Simple y robusto para MVP
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw);
  return ok ? raw : null;
}

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
  return ["cita","consulta","reservar","reserva","turno","agendar","appointment","book","booking","schedule", "agedar", "agendar cita", "agendarme", "agenda", "agend","bok", "scheduel"];
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

  const [_, date, hhmm] = m;

  // Construye en TZ real
  const dt = DateTime.fromFormat(`${date} ${hhmm}`, "yyyy-MM-dd HH:mm", { zone: timeZone });
  if (!dt.isValid) return null;

  const startISO = dt.toISO(); // incluye offset correcto -05 o -04
  const endISO = dt.plus({ minutes: 30 }).toISO();

  return { startISO, endISO, timeZone };
}

function parseFullName(input: string) {
  const raw = String(input || "").trim().replace(/\s+/g, " ");
  if (!raw) return null;

  // Evita que pongan solo 1 palabra
  const parts = raw.split(" ").filter(Boolean);
  if (parts.length < 2) return null;

  // (Opcional) filtro mínimo para evitar basura tipo "aa"
  const letters = raw.replace(/[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ\s'-]/g, "").trim();
  if (letters.split(" ").filter(Boolean).length < 2) return null;

  return raw;
}

async function upsertClienteBookingData(opts: {
  tenantId: string;
  canal: string;
  contacto: string;
  nombre?: string | null;
  email?: string | null;
}) {
  const { tenantId, canal, contacto, nombre, email } = opts;

  try {
    await pool.query(
      `
      INSERT INTO clientes (tenant_id, canal, contacto, nombre, email, updated_at, created_at)
      VALUES ($1,$2,$3,$4,$5, NOW(), NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET
        nombre = COALESCE(EXCLUDED.nombre, clientes.nombre),
        email  = COALESCE(EXCLUDED.email,  clientes.email),
        updated_at = NOW()
      `,
      [tenantId, canal, contacto, nombre || null, email || null]
    );
  } catch (e: any) {
    console.warn("⚠️ upsertClienteBookingData failed:", e?.message);
  }
}

async function insertAppointment(opts: {
  tenantId: string;
  channel: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
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
      ? "Perfect. To book, send in ONE message: First & last name + Email + Date & time (YYYY-MM-DD HH:mm). Example: John Smith, john@email.com, 2026-01-21 14:00"
      : "Perfecto. Para agendar, envíame en UN solo mensaje: Nombre y apellido + Email + Fecha y hora (YYYY-MM-DD HH:mm). Ej: Juan Pérez, juan@email.com, 2026-01-21 14:00",
    ctxPatch: {
      booking: { step: "ask_all", timeZone },
    },
  };
}

if (booking.step === "ask_all") {
  // Escape si cambió de tema -> salimos del flow
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const parsed = parseAllInOne(userText, timeZone);

  // Si vino completo, vamos directo a confirm
  if (parsed.name && parsed.email && parsed.startISO && parsed.endISO) {
    return {
      handled: true,
      reply: idioma === "en"
        ? `Confirm booking for ${parsed.startISO}? Reply YES to confirm or NO to cancel.`
        : `Confirmo: ${parsed.startISO}. Responde SI para confirmar o NO para cancelar.`,
      ctxPatch: {
        booking: {
          step: "confirm",
          timeZone,
          name: parsed.name,
          email: parsed.email,       // ✅ obligatorio
          start_time: parsed.startISO,
          end_time: parsed.endISO,
        },
      },
    };
  }

  // Si falta algo, hacemos fallback pidiendo SOLO lo faltante (en orden)
  if (!parsed.name) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "I’m missing your first and last name (example: John Smith)."
        : "Me falta tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: {
        booking: {
          step: "ask_name",
          timeZone,
          email: parsed.email || (booking as any)?.email || null,
        },
      },
    };
  }

  if (!parsed.email) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "I’m missing your email (example: name@email.com)."
        : "Me falta tu email (ej: nombre@email.com).",
      ctxPatch: {
        booking: {
          step: "ask_email",
          timeZone,
          name: parsed.name || (booking as any)?.name || null,
        },
      },
    };
  }

  // Falta fecha/hora
  return {
    handled: true,
    reply: idioma === "en"
      ? "I’m missing the date/time. Please use: YYYY-MM-DD HH:mm (example: 2026-01-21 14:00)."
      : "Me falta la fecha y hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-21 14:00).",
    ctxPatch: {
      booking: {
        step: "ask_datetime",
        timeZone,
        name: parsed.name || (booking as any)?.name || null,
        email: parsed.email || (booking as any)?.email || null, // ✅ si ya lo tenía
      },
    },
  };
}

// 1.1) Esperando nombre y apellido
if (booking.step === "ask_name") {
  // Escape si cambió de tema -> salimos del flow
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const name = parseFullName(userText);
  if (!name) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Please send your first and last name (example: John Smith)."
        : "Envíame tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: { booking: { ...booking, step: "ask_name", timeZone } },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: name,
  });

  return {
    handled: true,
    reply: idioma === "en"
      ? "Thanks. Now send your email."
      : "Gracias. Ahora envíame tu email.",
    ctxPatch: {
      booking: {
        step: "ask_email",
        timeZone,
        name,
      },
    },
  };
}

// 1.2) Esperando email (OBLIGATORIO)
if (booking.step === "ask_email") {
  // Escape si cambió de tema -> salimos del flow
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const email = parseEmail(userText);
  if (!email) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Please send a valid email (example: name@email.com)."
        : "Envíame un email válido (ej: nombre@email.com).",
      ctxPatch: { booking: { ...booking, step: "ask_email", timeZone } },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: (booking as any)?.name || null,
    email,
  });

  return {
    handled: true,
    reply: idioma === "en"
      ? "Great. Now send the date and time in this format: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
      : "Perfecto. Ahora envíame la fecha y hora en este formato: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00).",
    ctxPatch: {
      booking: {
        step: "ask_datetime",
        timeZone,
        name: (booking as any)?.name, // preserva lo capturado
        email,
      },
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
            ...booking,            // ✅ preserva name/email
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
    const customer_name = booking.name || "Cliente";
    const customer_email = booking.email; // ya no debería ser null
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
        [tenantId, "booking", lockId]
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
      customer_email: booking.email,
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
      ctxPatch: {
        booking: { step: "idle" },
        last_appointment_id: apptId,
        booking_completed: true,   // 👈 FLAG FINAL
      },
    };
  }

  return { handled: false };
}
