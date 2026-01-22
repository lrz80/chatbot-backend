// src/lib/appointments/bookingFlow.ts
import pool from "../db";
import { googleFreeBusy, googleCreateEvent } from "../../services/googleCalendar";
import { canUseChannel } from "../features";
import { DateTime } from "luxon";
import type { GoogleFreeBusyResponse, GoogleBusyBlock } from "../../services/googleCalendar";


type BookingCtx = {
  booking?: {
    step?: "idle" | "ask_purpose" | "ask_all" | "ask_name" | "ask_email" | "ask_datetime" | "offer_slots" | "confirm";
    start_time?: string;
    end_time?: string;
    timeZone?: string;
    name?: string;
    email?: string;
    purpose?: string;
    date_only?: string | null;
    slots?: Array<{ startISO: string; endISO: string }>;
  };
};

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const MIN_LEAD_MINUTES = 5; // o 0 si quieres permitir "ahora mismo"

function isPastSlot(startISO: string, timeZone: string) {
  const start = DateTime.fromISO(startISO, { zone: timeZone });
  const now = DateTime.now().setZone(timeZone);

  if (!start.isValid) return true;

  // Requerimos que el start sea >= now + MIN_LEAD_MINUTES
  const minStart = now.plus({ minutes: MIN_LEAD_MINUTES });

  return start < minStart;
}

function normalizeText(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^\w\s:@.-]/g, " ")    // quita signos raros
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitDateTime(text: string) {
  return /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/.test(String(text || ""));
}

function hasAppointmentContext(text: string) {
  const t = normalizeText(text);

  // ✅ agend + (para agendar, agendarrr, agendarr, agendar., agendando, agendame, etc.)
  const agendLike = /\bagend+a+\w*\b/; // captura "agendar", "agendarrr", "agendame", "agendando"
  const bookLike =
    /\b(cita|consulta|reservar|reserva|turno|appointment|booking|schedule)\b/;

  return agendLike.test(t) || bookLike.test(t);
}

function isCapabilityQuestion(text: string) {
  const t = normalizeText(text);

  // Debe estar preguntando (signo ? o estructura interrogativa)
  const looksLikeQuestion =
    /\?/.test(text) || /\b(que|qué|como|cómo|cuál|cual)\b/.test(t);

  // Preguntas típicas de capacidad (las que ya tenías)
  const q =
    /\b(puede|pueden|se puede|puedes|podria|podrían|capaz|permite|permiten|hace|hacen|incluye|incluyen)\b/.test(t) ||
    /\b(can you|can it|does it|do you|is it able to|are you able to)\b/.test(t);

  // ✅ NUEVO: preguntas de capacidad “directas” sin verbos tipo "puede"
  // Ej: "¿reserva citas?", "¿agenda?", "¿book appointments?"
  const bookingCapability =
    /\b(reserva|reservas|reservar|agenda|agendas|agendar|agendame|agéndame|programa|programas|programar)\b/.test(t) ||
    /\b(schedule|schedules|book|books|booking)\b/.test(t);

  const shortNoQuestionMark =
    t.length <= 30 && /\b(reserva|agenda|agendar|reservar|schedule|book|booking)\b/.test(t);

  if (shortNoQuestionMark) return true;

  // Si es una pregunta y menciona agenda/reserva => es capacidad
  if (looksLikeQuestion && bookingCapability) return true;

  return q && looksLikeQuestion;
}

function isDirectBookingRequest(text: string) {
  const t = normalizeText(text);

  // Petición directa: "quiero agendar", "agéndame", "resérvame", "book me", etc.
  return (
    /\b(quiero|quisiera|necesito|me gustaria|me gustaría|vamos a|podemos)\s+(agendar|reservar|programar)\b/.test(t) ||
    /\b(agendame|agéndame|reservame|resérvame|programame|prográmame)\b/.test(t) ||
    /\b(book me|schedule me|reserve)\b/.test(t)
  );
}

async function getAppointmentSettings(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT default_duration_min, buffer_min, timezone, enabled
       FROM appointment_settings
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId]
  );

  return {
    default_duration_min: rows[0]?.default_duration_min ?? 30,
    buffer_min: rows[0]?.buffer_min ?? 10,
    timezone: rows[0]?.timezone ?? "America/New_York",
    enabled: rows[0]?.enabled ?? true,
  };
}

type DayHours = { start: string; end: string }; // "09:00" - "18:00"
type HoursByWeekday = {
  mon?: DayHours | null;
  tue?: DayHours | null;
  wed?: DayHours | null;
  thu?: DayHours | null;
  fri?: DayHours | null;
  sat?: DayHours | null;
  sun?: DayHours | null;
};

async function getBusinessHours(tenantId: string): Promise<HoursByWeekday | null> {
  try {
    const { rows } = await pool.query(
      `SELECT horario_atencion FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const raw = rows[0]?.horario_atencion;
    if (!raw) return null;

    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object") return null;

    // Soporta llaves: mon/tue..., monday..., lunes..., etc.
    const mapKey = (k: string) => {
      const x = String(k || "").toLowerCase().trim();
      if (["mon","monday","lunes"].includes(x)) return "mon";
      if (["tue","tues","tuesday","martes"].includes(x)) return "tue";
      if (["wed","weds","wednesday","miercoles","miércoles"].includes(x)) return "wed";
      if (["thu","thur","thurs","thursday","jueves"].includes(x)) return "thu";
      if (["fri","friday","viernes"].includes(x)) return "fri";
      if (["sat","saturday","sabado","sábado"].includes(x)) return "sat";
      if (["sun","sunday","domingo"].includes(x)) return "sun";
      return null;
    };

    const normalizeDay = (v: any): DayHours | null => {
      if (!v) return null;

      // Caso 1: {start,end}
      if (typeof v === "object" && (v.start || v.end)) {
        const start = String(v.start || "").trim();
        const end = String(v.end || "").trim();
        return start && end ? { start, end } : null;
      }

      // Caso 2: {open,close}
      if (typeof v === "object" && (v.open || v.close)) {
        const start = String(v.open || "").trim();
        const end = String(v.close || "").trim();
        return start && end ? { start, end } : null;
      }

      // Caso 3: ["09:00","18:00"]
      if (Array.isArray(v) && v.length >= 2) {
        const start = String(v[0] || "").trim();
        const end = String(v[1] || "").trim();
        return start && end ? { start, end } : null;
      }

      return null;
    };

    const out: HoursByWeekday = {};

    for (const [k, v] of Object.entries(obj as Record<string, any>)) {
      const wk = mapKey(k);
      if (!wk) continue;
      (out as any)[wk] = normalizeDay(v);
    }

    // si no pudimos mapear nada, devuelve null
    const anyDay = Object.values(out).some(Boolean);
    return anyDay ? out : null;
  } catch {
    return null;
  }
}

function weekdayKey(dt: DateTime): keyof HoursByWeekday {
  // Luxon: 1=Mon ... 7=Sun
  const w = dt.weekday;
  return (w === 1 ? "mon" :
          w === 2 ? "tue" :
          w === 3 ? "wed" :
          w === 4 ? "thu" :
          w === 5 ? "fri" :
          w === 6 ? "sat" : "sun");
}

function parseHHmm(hhmm: string) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

function subtractBusyFromWindow(opts: {
  windowStart: DateTime;
  windowEnd: DateTime;
  busy: Array<{ start: string; end: string }>;
  timeZone: string;
}): Array<{ start: DateTime; end: DateTime }> {
  const { windowStart, windowEnd, busy, timeZone } = opts;

  // Normaliza busy a DateTime y ordena
  const busyBlocks = (busy || [])
    .map(b => ({
      start: DateTime.fromISO(b.start, { zone: timeZone }),
      end: DateTime.fromISO(b.end, { zone: timeZone }),
    }))
    .filter(b => b.start.isValid && b.end.isValid)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  // Merge overlaps
  const merged: Array<{ start: DateTime; end: DateTime }> = [];
  for (const b of busyBlocks) {
    const last = merged[merged.length - 1];
    if (!last) merged.push(b);
    else if (b.start <= last.end) last.end = DateTime.max(last.end, b.end);
    else merged.push(b);
  }

  // Restar de la ventana
  let cursor = windowStart;
  const free: Array<{ start: DateTime; end: DateTime }> = [];

  for (const b of merged) {
    const bs = DateTime.max(b.start, windowStart);
    const be = DateTime.min(b.end, windowEnd);
    if (be <= windowStart || bs >= windowEnd) continue;

    if (bs > cursor) free.push({ start: cursor, end: bs });
    cursor = DateTime.max(cursor, be);
  }

  if (cursor < windowEnd) free.push({ start: cursor, end: windowEnd });

  return free;
}

function sliceIntoSlots(opts: {
  freeRanges: Array<{ start: DateTime; end: DateTime }>;
  durationMin: number;
  bufferMin: number;
  timeZone: string;
}): Array<{ startISO: string; endISO: string }> {
  const { freeRanges, durationMin, bufferMin, timeZone } = opts;

  const slots: Array<{ startISO: string; endISO: string }> = [];

  for (const r of freeRanges) {
    // respeta lead time
    let start = r.start;
    const now = DateTime.now().setZone(timeZone).plus({ minutes: MIN_LEAD_MINUTES });
    if (start < now) start = now;

    // redondeo opcional a 5 min
    start = start.set({ second: 0, millisecond: 0 });

    // iterar slots
    while (start.plus({ minutes: durationMin }) <= r.end) {
      const end = start.plus({ minutes: durationMin });

      // aplica buffer: evita que el slot “pegue” con el siguiente
      // (si no quieres, puedes quitar esto)
      const endWithBuffer = end.plus({ minutes: bufferMin });
      if (endWithBuffer <= r.end.plus({ minutes: 0 })) {
        const sISO = start.toISO();
        const eISO = end.toISO();
        if (sISO && eISO) slots.push({ startISO: sISO, endISO: eISO });
      }

      // saltar en incrementos de 15 min (ajusta si quieres)
      start = start.plus({ minutes: 15 });
    }
  }

  return slots;
}

async function getSlotsForDate(opts: {
  tenantId: string;
  timeZone: string;
  dateISO: string; // "YYYY-MM-DD"
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
}): Promise<Array<{ startISO: string; endISO: string }>> {
  const { tenantId, timeZone, dateISO, durationMin, bufferMin, hours } = opts;

  const day = DateTime.fromFormat(dateISO, "yyyy-MM-dd", { zone: timeZone });
  if (!hours) return [];
  if (!day.isValid) return [];

  const key = weekdayKey(day);
  const dayHours = hours?.[key];

  // si ese día está cerrado
  if (!dayHours || !dayHours.start || !dayHours.end) return [];

  const st = parseHHmm(dayHours.start);
  const en = parseHHmm(dayHours.end);
  if (!st || !en) return [];

  const windowStart = day.set({ hour: st.h, minute: st.min, second: 0, millisecond: 0 });
  const windowEnd = day.set({ hour: en.h, minute: en.min, second: 0, millisecond: 0 });

  if (!windowStart.isValid || !windowEnd.isValid || windowEnd <= windowStart) return [];

  // Pedimos freebusy para TODA la ventana del día
  const fb: GoogleFreeBusyResponse = await googleFreeBusy({
    tenantId,
    timeMin: windowStart.toISO()!,
    timeMax: windowEnd.toISO()!,
    calendarId: "primary",
  });

  const busy =
    fb?.calendars?.primary?.busy ||
    fb?.calendars?.["primary"]?.busy ||
    (fb?.calendars && Object.values(fb.calendars)[0]?.busy) ||
    [];

  const freeRanges = subtractBusyFromWindow({
    windowStart,
    windowEnd,
    busy,
    timeZone,
  });

  // crea slots
  const slots = sliceIntoSlots({
    freeRanges,
    durationMin,
    bufferMin,
    timeZone,
  });

  // máximo 5 (para chat)
  return slots.slice(0, 5);
}

function renderSlotsMessage(opts: {
  idioma: "es" | "en";
  timeZone: string;
  slots: Array<{ startISO: string; endISO: string }>;
}): string {
  const { idioma, timeZone, slots } = opts;

  if (!slots.length) {
    return idioma === "en"
      ? "I couldn’t find available times for that date. Please choose another date."
      : "No encontré horarios disponibles para esa fecha. ¿Me dices otra fecha?";
  }

  const lines = slots.map((s, i) => {
    const human = formatSlotHuman({ startISO: s.startISO, timeZone, idioma });
    return `${i + 1}) ${human}`;
  });

  return idioma === "en"
    ? `These times are available:\n${lines.join("\n")}\nReply with the number (1-${slots.length}).`
    : `Tengo estos horarios disponibles:\n${lines.join("\n")}\nResponde con el número (1-${slots.length}).`;
}

function parseSlotChoice(text: string, max: number): number | null {
  const t = String(text || "").trim();
  const m = t.match(/^(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > max) return null;
  return n;
}

function buildAskAllMessage(idioma: "es" | "en", purpose?: string | null) {
  const p = purpose ? ` (${purpose})` : "";

  if (idioma === "en") {
    return (
      `Sure! I can help you with that.\n` +
      `Please send me everything together in ONE message:\n` +
      `Your full name, email, and the date & time you’d like.\n` +
      `Example: John Smith, john@email.com, 2026-01-21 14:00`
    );
  }

  return (
    `¡Claro! Te ayudo con eso.\n` +
    `Solo envíame todo junto en **un solo mensaje**:\n` +
    `Tu nombre completo, email y la fecha y hora que te gustaría.\n` +
    `Ejemplo: Juan Pérez, juan@email.com, 2026-01-21 14:00`
  );
}

function detectPurpose(text: string): string | null {
  const t = normalizeText(text);

  if (/\b(demo|demostracion|demostración|demonstration)\b/.test(t)) return "demo";
  if (/\b(clase|class|trial)\b/.test(t)) return "clase";

  // ✅ cita / appointment (ESTO RESUELVE TU BUG)
  if (/\b(cita|appointment|appt)\b/.test(t)) return "cita";

  if (/\b(consulta|consultation|asesoria|asesoría)\b/.test(t)) return "consulta";
  if (/\b(llamada|call|phone)\b/.test(t)) return "llamada";
  if (/\b(visita|visit|presencial|in person)\b/.test(t)) return "visita";

  // (opcional) si dicen "reservar/reserva/turno" sin más, trátalo como cita
  if (/\b(reservar|reserva|turno|agendar|agenda)\b/.test(t)) return "cita";

  return null;
}

function extractDateTimeToken(input: string): string | null {
  const m = String(input || "").match(/\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\b/);
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

function wantsToCancel(text: string) {
  const t = normalizeText(text);
  return /\b(cancelar|cancela|olvida|stop|salir|exit|no gracias|nah|nope|ya no|dejalo|dejalo asi|deja eso|later)\b/i.test(t);
}

function extractDateOnlyToken(input: string): string | null {
  const m = String(input || "").match(/\b(\d{4}-\d{2}-\d{2})\b/);
  // evita colisionar con date+time
  const hasDateTime = /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(String(input || ""));
  if (hasDateTime) return null;
  return m?.[1] || null;
}

// ✅ Parser “todo en uno”: "Juan Perez, juan@email.com, 2026-01-21 14:00"
function parseAllInOne(input: string, timeZone: string, durationMin: number): {
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
  const dtParsed = dtToken ? parseDateTimeExplicit(dtToken, timeZone, durationMin) : null;

  const startISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.startISO || null;

  const endISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.endISO || null;

  // 3) Nombre: resto del texto sin email ni fecha
  let nameCandidate = raw;
  if (email) nameCandidate = removeOnce(nameCandidate, email);
  if (dtToken) nameCandidate = removeOnce(nameCandidate, dtToken);

  nameCandidate = cleanNameCandidate(nameCandidate);

  // ✅ NUEVO: limpia “ruido” cuando viene en párrafos largos
  nameCandidate = nameCandidate
    .replace(/\b(quiero|quisiera|me gustaria|hola|buenas|buenos|agendar|agenda|cita|consulta|demo|clase|reservar|reserva|turno|appointment|booking|schedule|para|por favor|pls|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // ya lo tenías (puedes dejarlo o unirlo arriba)
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
  const t = normalizeText(text);
  return terms.some((term) => {
    const x = normalizeText(term);
    if (!x) return false;
    // match por palabra o frase (si la term tiene espacio, usamos includes)
    if (x.includes(" ")) return t.includes(x);
    return new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  });
}

/**
 * MVP: Pedimos fecha/hora en formato explícito:
 *   YYYY-MM-DD HH:mm (hora local del negocio)
 * Ej: 2026-01-17 15:00
 */
function parseDateTimeExplicit(input: string, timeZone: string, durationMin: number) {
  const m = String(input || "").trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (!m) return null;

  const [_, date, hhmm] = m;

  const dt = DateTime.fromFormat(`${date} ${hhmm}`, "yyyy-MM-dd HH:mm", { zone: timeZone });
  if (!dt.isValid) return null;

  const startISO = dt.toISO();
  const endISO = dt.plus({ minutes: durationMin }).toISO();
  if (!startISO || !endISO) return null;

  // ✅ BLOQUEO PASADO (usa tu helper)
  if (isPastSlot(startISO, timeZone)) {
    return { startISO: null, endISO: null, timeZone, error: "PAST_SLOT" as const };
  }

  return { startISO, endISO, timeZone };
}

function formatSlotHuman(opts: {
  startISO: string;
  timeZone: string;
  idioma: "es" | "en";
}) {
  const { startISO, timeZone, idioma } = opts;

  const dt = DateTime.fromISO(startISO, { zone: timeZone });
  if (!dt.isValid) return startISO;

  if (idioma === "en") {
    // Example: Mar 20, 2026 at 4:00 PM
    return dt.setLocale("en").toFormat("LLL d, yyyy 'at' h:mm a");
  }

  // Example: 20 Mar 2026, 4:00 PM  (si prefieres 16:00, te lo ajusto)
  return dt.setLocale("es").toFormat("d LLL yyyy, h:mm a");
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

function parseAskAll(input: string, timeZone: string, durationMin: number) {
  const raw = String(input || "").trim();

  const email = parseEmail(raw);
  if (!email) return null;

  const m = raw.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (!m) return null;

  const dt = parseDateTimeExplicit(`${m[1]} ${m[2]}`, timeZone, durationMin);
  if (!dt) return null;

  const nameCandidate = raw
    .replace(email, " ")
    .replace(m[0], " ")
    .replace(/[,;|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const name = parseFullName(nameCandidate);
  if (!name) return null;

  return { name, email, startISO: dt.startISO!, endISO: dt.endISO!, timeZone };
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

async function markAppointmentConfirmed(opts: {
  apptId: string;
  google_event_id: string | null;
  google_event_link: string | null;
}) {
  const { apptId, google_event_id, google_event_link } = opts;
  await pool.query(
    `
    UPDATE appointments
       SET status='confirmed',
           google_event_id=$2,
           google_event_link=$3
     WHERE id=$1
    `,
    [apptId, google_event_id, google_event_link]
  );
}

async function markAppointmentFailed(opts: {
  apptId: string;
  error_reason: string;
}) {
  const { apptId, error_reason } = opts;
  await pool.query(
    `
    UPDATE appointments
       SET status='failed',
           error_reason=$2
     WHERE id=$1
    `,
    [apptId, error_reason]
  );
}

async function createPendingAppointmentOrGetExisting(opts: {
  tenantId: string;
  channel: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  start_time: string;
  end_time: string;
}) {
  const {
    tenantId, channel, customer_name, customer_phone, customer_email, start_time, end_time,
  } = opts;

  // Inserta pending, si ya existe el mismo slot para ese cliente, trae el existente
  const { rows } = await pool.query(
    `
    INSERT INTO appointments (
      tenant_id, service_id, channel, customer_name, customer_phone, customer_email,
      start_time, end_time, status, google_event_id, google_event_link
    )
    VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, 'pending', NULL, NULL)
    ON CONFLICT (tenant_id, channel, customer_phone, start_time)
    DO UPDATE SET
      customer_name = COALESCE(EXCLUDED.customer_name, appointments.customer_name),
      customer_email = COALESCE(EXCLUDED.customer_email, appointments.customer_email),
      end_time = EXCLUDED.end_time
    RETURNING id, status, google_event_link, google_event_id
    `,
    [
      tenantId,
      channel,
      customer_name,
      customer_phone || null,
      customer_email || null,
      start_time,
      end_time,
    ]
  );

  return rows[0] || null;
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
  bufferMin: number;
}) {
  const { tenantId, customer_name, startISO, endISO, timeZone, bufferMin } = opts;

  const start = DateTime.fromISO(startISO, { zone: timeZone });
  const end = DateTime.fromISO(endISO, { zone: timeZone });

  if (!start.isValid || !end.isValid) {
    return { ok: false as const, error: "INVALID_DATETIME" as const, busy: [] as any[] };
  }

  // ✅ BLOQUEO FINAL: NO permitir eventos en el pasado
  const now = DateTime.now().setZone(timeZone);
  if (start < now.plus({ minutes: MIN_LEAD_MINUTES })) {
    return { ok: false as const, error: "PAST_SLOT" as const, busy: [] as any[] };
  }

  const timeMin = start.minus({ minutes: bufferMin }).toISO();
  const timeMax = end.plus({ minutes: bufferMin }).toISO();

  if (!timeMin || !timeMax) {
    return { ok: false as const, error: "INVALID_DATETIME" as const, busy: [] as any[] };
  }

  // ✅ aquí ya son string seguros
  const fb = await googleFreeBusy({
    tenantId,
    timeMin,
    timeMax,
    calendarId: "primary",
  });


  const busy = fb?.calendars?.primary?.busy || [];
  console.log("📅 [BOOKING] freebusy", {
    tenantId,
    timeMin,
    timeMax,
    busyCount: busy.length,
  });

  if (busy.length > 0) {
    return { ok: false as const, error: "SLOT_BUSY" as const, busy };
  }

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

  // ✅ carga settings del tenant (MVP)
  const apptSettings = await getAppointmentSettings(tenantId);

  if (apptSettings.enabled === false) {
    const quickWants =
      booking.step !== "idle" ||
      hasExplicitDateTime(userText) ||
      hasAppointmentContext(userText);

    if (quickWants) {
      return {
      handled: true,
      reply: idioma === "en"
        ? "Scheduling is unavailable right now."
        : "El agendamiento no está disponible en este momento.",
      ctxPatch: { booking: { step: "idle" } },
      };
    }

    return { handled: false };
  }

  // ✅ timezone real del negocio (prioridad: ctx > settings > fallback)
  const timeZone = booking.timeZone || apptSettings.timezone || "America/New_York";

  // ✅ valores MVP
  const durationMin = apptSettings.default_duration_min ?? 30;
  const bufferMin = apptSettings.buffer_min ?? 10;

  const hours = await getBusinessHours(tenantId);

  // ✅ POST-BOOKING GUARD (SAFE):
  // NO usar last_appointment_id como gatillo global.
  // Solo responde con link si el booking se completó RECIENTEMENTE.
  const t0 = String(userText || "").trim().toLowerCase();
  const isYesNo = /^(si|sí|yes|y|no|n)$/i.test(t0);

  if (booking.step === "idle" && isYesNo) {
    const lastDoneAt =
      (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as any)?.booking_last_done_at : null;

    const lastMs = typeof lastDoneAt === "number" ? lastDoneAt : null;

    // ventana corta: 10 minutos
    const withinWindow =
      lastMs && Number.isFinite(lastMs)
        ? ((Date.now() - lastMs) >= 0 && (Date.now() - lastMs) < 5 * 60 * 1000)
        : false;

    if (withinWindow) {
      const lastLink =
        (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as any)?.booking_last_event_link : null;

      const link = typeof lastLink === "string" ? lastLink.trim() : "";

      // si no hay link, no interceptes (deja que el SM responda)
      if (!link) return { handled: false };

      return {
        handled: true,
        reply: idioma === "en"
          ? `Already booked. ${link}`.trim()
          : `Ya quedó agendado. ${link}`.trim(),
        ctxPatch: {
          booking: { step: "idle" },
          // ✅ opcional: limpia ids viejos para que nunca se usen como gatillo
          last_appointment_id: null,
        },
      };
    }
  }

  const terms = await loadBookingTerms(tenantId);
  const rawWants = matchesBookingIntent(userText, terms);

  const capability = isCapabilityQuestion(userText);
  const directReq = isDirectBookingRequest(userText);

  const wantsBooking =
    hasExplicitDateTime(userText) ||
    directReq ||
    (rawWants && !capability) ||
    (hasAppointmentContext(userText) && !capability);

  if (booking.step === "idle" && capability && hasAppointmentContext(userText) && !hasExplicitDateTime(userText) && !directReq) {
    return {
      handled: true,
      reply: idioma === "en"
  ? "Yes — Aamy can schedule your business appointments using Google Calendar. Would you like to schedule a call with our team to learn more? Reply: 'I want to schedule'."
  : "Sí — Aamy puede agendar las citas de tu negocio usando Google Calendar. ¿Te gustaría programar una llamada con nuestro equipo para saber más? Escribe: 'Quiero agendar'.",
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const gate = await canUseChannel(tenantId, "google_calendar");
  const bookingEnabled = !!gate.settings_enabled;
  console.log("📅 [BOOKING] gate:", { settings_enabled: gate.settings_enabled, plan_enabled: gate.plan_enabled, enabled: gate.enabled });

  const googleConnected = await isGoogleConnected(tenantId);

  const bookingLink = opts.bookingLink ? String(opts.bookingLink).trim() : null;

  // 1) Si el tenant apagó agendamiento: bloquea todo
  if (!bookingEnabled) {
    if (wantsBooking || booking.step !== "idle") {
      return {
        handled: true,
        reply: idioma === "en"
            ? "Scheduling is unavailable right now."
            : "El agendamiento no está disponible en este momento.",
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
      ? "Scheduling is unavailable right now."
      : "El agendamiento no está disponible en este momento.",
    ctxPatch: { booking: { step: "idle" } },
  };
}

// 1) Arranque: detecta intención y pide fecha/hora
if (booking.step === "idle") {
  if (!wantsBooking) return { handled: false };

  const purpose = detectPurpose(userText);

  // ✅ solo si NO detecta propósito -> pregunta
  if (!purpose) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Sure! What would you like to schedule — an appointment, a consultation, or a call?"
        : "¡Claro! ¿Qué te gustaría agendar? Una cita, una consulta o una llamada.",
      ctxPatch: { booking: { step: "ask_purpose", timeZone } },
    };
  }

  // ✅ ya hay propósito -> pide todos los datos en 1 mensaje
  return {
    handled: true,
    reply: buildAskAllMessage(idioma, purpose),
    ctxPatch: { booking: { step: "ask_all", timeZone, purpose } },
  };
}

if (booking.step === "ask_purpose") {
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  const purpose = detectPurpose(userText);

  // Si aún no lo detecta, no lo trances: dale opciones otra vez
  if (!purpose) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Got it. Is it a appointment, class, consultation, or a call?"
        : "Entiendo. ¿Es una cita, clase, consulta o llamada?",
      ctxPatch: { booking: { ...booking, step: "ask_purpose", timeZone } },
    };
  }

  return {
    handled: true,
    reply: buildAskAllMessage(idioma, purpose),
    ctxPatch: { booking: { step: "ask_all", timeZone, purpose } },
  };
}

if (booking.step === "ask_all") {
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
        : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: { booking: { step: "idle", start_time: null, end_time: null, timeZone, name: null, email: null, purpose: null, date_only: null } },
    };
  }

  const parsed = parseAllInOne(userText, timeZone, durationMin);

  // ✅ Si vino fecha/hora pero era en el pasado, dilo explícitamente
  const dtToken = extractDateTimeToken(userText);
  if (dtToken) {
    const chk: any = parseDateTimeExplicit(dtToken, timeZone, durationMin);
    if (chk?.error === "PAST_SLOT") {
      return {
        handled: true,
        reply: idioma === "en"
          ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
          : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            step: "ask_datetime",
            timeZone,
            name: parsed.name || (booking as any)?.name || null,
            email: parsed.email || (booking as any)?.email || null,
            date_only: null,
          },
        },
      };
    }
  }

  const dateOnly = extractDateOnlyToken(userText);
  if (dateOnly && parsed.name && parsed.email && !parsed.startISO) {
    // bloquea fecha pasada (lo dejas igual que ya lo tienes)
    const dateOnlyDt = DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: timeZone });
    const todayStart = DateTime.now().setZone(timeZone).startOf("day");
    if (dateOnlyDt.isValid && dateOnlyDt < todayStart) {
      return {
        handled: true,
        reply: idioma === "en"
            ? "That date is in the past. Please send a future date (YYYY-MM-DD)."
            : "Esa fecha ya pasó. Envíame una fecha futura (YYYY-MM-DD).",
        ctxPatch: {
            booking: { step: "ask_datetime", timeZone, name: parsed.name, email: parsed.email, date_only: null, slots: [] },
        },
      };
    }

    if (!hours) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "This business hasn’t set business hours yet. Please send the exact date & time (YYYY-MM-DD HH:mm)."
        : "Este negocio aún no tiene horario de atención configurado. Envíame fecha y hora exacta (YYYY-MM-DD HH:mm).",
      ctxPatch: {
        booking: {
          step: "ask_datetime",
          timeZone,
          name: parsed.name,
          email: parsed.email,
          date_only: null,
          slots: [],
        },
      },
    };
  }

    // ✅ NUEVO: generar slots para ese día
    const slots = await getSlotsForDate({
      tenantId,
      timeZone,
      dateISO: dateOnly,
      durationMin,
      bufferMin,
      hours,
    });

    return {
      handled: true,
      reply: renderSlotsMessage({ idioma, timeZone, slots }),
      ctxPatch: {
        booking: {
          step: "offer_slots",
          timeZone,
          name: parsed.name,
          email: parsed.email,
          purpose: booking.purpose || null,
          date_only: dateOnly,
          slots,
        },
      },
    };
  }

  // Si vino completo, vamos directo a confirm
  if (parsed.name && parsed.email && parsed.startISO && parsed.endISO) {
    const whenTxt = formatSlotHuman({ startISO: parsed.startISO, timeZone, idioma });
    return {
      handled: true,
      reply: idioma === "en"
        ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
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

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
        : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
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

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
        : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
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

if (booking.step === "offer_slots") {
  const t = normalizeText(userText);

    // Si pregunta por horarios estando en offer_slots, simplemente re-muestra opciones
    if (/\b(horario|horarios|hours|available)\b/i.test(t)) {
    const slots = Array.isArray((booking as any)?.slots) ? (booking as any).slots : [];

    if (!slots.length) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "I don’t have available times saved for that date. Please send another date (YYYY-MM-DD)."
          : "No tengo horarios disponibles guardados para esa fecha. Envíame otra fecha (YYYY-MM-DD).",
        ctxPatch: { booking: { step: "ask_datetime", timeZone, date_only: null, slots: [] } },
      };
    }

    if (!slots.length) {
      return {
        handled: true,
        reply: idioma === "en"
        ? "I don’t have available times saved for that date. Please send another date (YYYY-MM-DD)."
        : "No tengo horarios disponibles para esa fecha. Envíame otra fecha (YYYY-MM-DD).",
        ctxPatch: {
        booking: {
            ...booking,
            step: "ask_datetime",
            date_only: null,
            slots: [],
        },
        },
      };
    }

    return {
        handled: true,
        reply: renderSlotsMessage({ idioma, timeZone: booking.timeZone || timeZone, slots }),
        ctxPatch: { booking },
    };
    }

    // Ahora sí, cualquier otro cambio de tema
    if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
    }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Of course. I’ll stop the scheduling process for now."
        : "Claro. Detengo el proceso de agendamiento por ahora.",
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const slots = Array.isArray((booking as any)?.slots) ? (booking as any).slots : [];
  const choice = parseSlotChoice(userText, slots.length);

  if (!choice) {
    return {
      handled: true,
      reply: idioma === "en"
        ? `Please reply with a number (1-${slots.length}).`
        : `Responde con un número (1-${slots.length}).`,
      ctxPatch: { booking },
    };
  }

  const picked = slots[choice - 1];
  const whenTxt = formatSlotHuman({ startISO: picked.startISO, timeZone, idioma });

  return {
    handled: true,
    reply: idioma === "en"
      ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
      : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
    ctxPatch: {
      booking: {
        ...booking,
        step: "confirm",
        start_time: picked.startISO,
        end_time: picked.endISO,
        slots: [],        // limpia
        date_only: null,  // limpia
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

    if (wantsToCancel(userText)) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }

    const parsed: any = parseDateTimeExplicit(userText, timeZone, durationMin);

    const b: any = booking;
    const hhmm = String(userText || "").trim().match(/^(\d{2}:\d{2})$/);

    if (b?.date_only && hhmm) {
      const parsed2: any = parseDateTimeExplicit(`${b.date_only} ${hhmm[1]}`, timeZone, durationMin);

      if (!parsed2) {
        return {
          handled: true,
          reply: idioma === "en"
            ? `I couldn’t read that time. Please use HH:mm (example: 14:00).`
            : `No pude leer esa hora. Usa HH:mm (ej: 14:00).`,
          ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
        };
      }

      // ✅ BLOQUEO: hora en el pasado (cuando ya tenemos date_only)
      if (parsed2?.error === "PAST_SLOT") {
        return {
          handled: true,
          reply: idioma === "en"
            ? "That time is in the past. Please send a future time (HH:mm)."
            : "Esa hora ya pasó. Envíame una hora futura (HH:mm).",
          ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
        };
      }

      const whenTxt = formatSlotHuman({ startISO: parsed2.startISO!, timeZone, idioma });

      return {
        handled: true,
        reply: idioma === "en"
          ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
          : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
        ctxPatch: {
          booking: {
            ...booking,
            step: "confirm",
            start_time: parsed2.startISO,
            end_time: parsed2.endISO,
            timeZone,
            date_only: null,
          },
        },
      };
    }

    if (!parsed) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "I couldn’t read that. Please use: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
          : "No pude leer esa fecha/hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
      };
    }

    // ✅ BLOQUEO: fecha/hora en el pasado
    if (parsed?.error === "PAST_SLOT") {
      return {
        handled: true,
        reply: idioma === "en"
          ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
          : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
      };
    }

    const whenTxt = formatSlotHuman({ startISO: parsed.startISO!, timeZone, idioma });
    return {
      handled: true,
      reply: idioma === "en"
        ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
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
          ? "No problem. Send me another date and time (YYYY-MM-DD HH:mm)."
          : "Perfecto. Envíame otra fecha y hora (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            ...booking, // ✅ preserva name/email/purpose/lo que exista
            step: "ask_datetime", // 🔑 OBLIGATORIO
            timeZone: booking.timeZone || timeZone,

            // preservamos datos válidos
            name: booking.name || null,
            email: booking.email || null,
            purpose: booking.purpose || null,

            // limpiamos COMPLETAMENTE el slot anterior
            start_time: null,
            end_time: null,
            date_only: null,
          },
        },
      };
    }

    if (wantsToCancel(userText)) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }

    // YES -> agenda en Google + guarda en DB
    const customer_name = booking.name || "Cliente";
    const customer_email = booking.email; // ya no debería ser null

    if (!booking.start_time || !booking.end_time) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Send me the date and time (YYYY-MM-DD HH:mm)."
          : "Envíame la fecha y hora (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime" } },
      };
    }

    const startISO = booking.start_time!;
    const endISO = booking.end_time!;

    // ✅ DEDUPE REAL: crea/obtén un appointment PENDING con UNIQUE en DB
    const pending = await createPendingAppointmentOrGetExisting({
    tenantId,
    channel: canal,
    customer_name,
    customer_phone: contacto,
    customer_email: booking.email,
    start_time: startISO,
    end_time: endISO,
    });

    if (!pending) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Something went wrong creating your booking. Please try again."
          : "Ocurrió un problema creando la reserva. Por favor intenta de nuevo.",
        ctxPatch: { booking: { step: "ask_datetime", timeZone } },
      };
    }

    // Si ya estaba confirmado, responde idempotente con el link
    if (pending.status === "confirmed" && pending.google_event_link) {
      return {
        handled: true,
        reply: idioma === "en"
        ? `Already booked. ${pending.google_event_link}`.trim()
        : `Ya quedó agendado. ${pending.google_event_link}`.trim(),
        ctxPatch: { booking: { step: "idle" } },
      };
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
      bufferMin,
    });

    if (!g.ok) {
      await markAppointmentFailed({
        apptId: pending.id,
        error_reason: String((g as any)?.error || "GOOGLE_ERROR"),
      });

      if ((g as any)?.error === "SLOT_BUSY") {
        // intentar proponer alternativas del MISMO día (si tenemos fecha)
        const day = DateTime.fromISO(startISO, { zone: timeZone });
        const dateISO = day.isValid ? day.toFormat("yyyy-MM-dd") : null;

        if (dateISO) {
          const slots = await getSlotsForDate({
            tenantId,
            timeZone,
            dateISO,
            durationMin,
            bufferMin,
            hours,
          });

          if (slots.length) {
            return {
              handled: true,
              reply: renderSlotsMessage({ idioma, timeZone, slots }),
              ctxPatch: {
                booking: {
                  ...booking,
                  step: "offer_slots",
                  timeZone,
                  slots,
                },
              },
            };
          }
        }
      }

      if ((g as any)?.error === "PAST_SLOT") {
        return {
          handled: true,
          reply: idioma === "en"
            ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
            : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
          ctxPatch: { booking: { step: "ask_datetime", timeZone } },
        };
      }

      return {
        handled: true,
        reply: idioma === "en"
          ? "That time doesn’t seem to be available. Could you send me another date and time? (YYYY-MM-DD HH:mm)"
          : "Ese horario ya no está disponible. ¿Me compartes otra fecha y hora? (YYYY-MM-DD HH:mm)",
        ctxPatch: { booking: { step: "ask_datetime", timeZone } },
      };
    }

    await markAppointmentConfirmed({
      apptId: pending.id,
      google_event_id: g.event_id,
      google_event_link: g.htmlLink,
    });

    const apptId = pending.id;

    return {
      handled: true,
      reply: idioma === "en"
        ? `You're all set — your appointment is confirmed. ${g.htmlLink || ""}`.trim()
        : `Perfecto, tu cita quedó confirmada. ${g.htmlLink || ""}`.trim(),
      ctxPatch: {
        booking: { step: "idle" },
        last_appointment_id: apptId,
        booking_completed: true,
        booking_completed_at: new Date().toISOString(),
        booking_last_done_at: Date.now(),
        booking_last_event_link: g.htmlLink || null,
      },
    };
  }

  return { handled: false };
}
