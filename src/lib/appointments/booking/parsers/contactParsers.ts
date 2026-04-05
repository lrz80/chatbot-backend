//src/lib/appointments/booking/parsers/contactParsers.ts
import { extractDateTimeToken } from "./dateTimeParsers";
import {
  EMAIL_REGEX,
  PHONE_REGEX,
  removeOnce,
  cleanNameCandidate,
} from "../shared/textCore";

export function parseEmail(input: string) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw);
  return ok ? raw : null;
}

export function parsePhone(text: string): string | null {
  const raw = String(text || "").trim();
  const m = raw.match(PHONE_REGEX)?.[0] || null;
  if (!m) return null;

  const cleaned = m.replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/[^\d]/g, "");
  if (digits.length < 8) return null;

  return cleaned;
}

export function parseFullName(input: string) {
  const raw = String(input || "").trim().replace(/\s+/g, " ");
  if (!raw) return null;

  const parts = raw.split(" ").filter(Boolean);
  if (parts.length < 2) return null;

  const letters = raw.replace(/[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ\s'-]/g, "").trim();
  if (letters.split(" ").filter(Boolean).length < 2) return null;

  return raw;
}

// "Juan Perez, juan@email.com, +13055551234, 2026-01-21 14:00"
export function parseAllInOne(
  input: string,
  timeZone: string,
  durationMin: number,
  minLeadMinutes: number,
  parseDateTimeExplicit: any
) {
  const raw = String(input || "").trim();

  // 1) Email
  const email = raw.match(EMAIL_REGEX)?.[0]?.toLowerCase() || null;

  // 2) DateTime explícito (YYYY-MM-DD HH:mm)
  const dtToken = extractDateTimeToken(raw);
  const dtParsed = dtToken
    ? parseDateTimeExplicit(dtToken, timeZone, durationMin, minLeadMinutes)
    : null;

  const startISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.startISO || null;
  const endISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.endISO || null;

  // 3) Phone
  const phone = parsePhone(raw);

  // 4) Construir candidato de nombre removiendo tokens conocidos
  let nameCandidate = raw;

  if (email) nameCandidate = removeOnce(nameCandidate, email);
  if (dtToken) nameCandidate = removeOnce(nameCandidate, dtToken);
  if (phone) nameCandidate = removeOnce(nameCandidate, phone);

  nameCandidate = cleanNameCandidate(nameCandidate);

  nameCandidate = nameCandidate
    .replace(
      /\b(quiero|quisiera|me gustaria|hola|buenas|buenos|agendar|agenda|cita|consulta|demo|clase|reservar|reserva|turno|appointment|booking|schedule|para|por favor|pls|please)\b/gi,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  nameCandidate = nameCandidate
    .replace(/\b(mi nombre es|soy|me llamo|name is|i am)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const name = nameCandidate ? parseFullName(nameCandidate) : null;

  return { name, email, phone, startISO, endISO };
}

export function parseNameEmailOnly(input: string) {
  const raw = String(input || "").trim();

  const email = raw.match(EMAIL_REGEX)?.[0]?.toLowerCase() || null;
  const phone = parsePhone(raw);

  let nameCandidate = raw;
  if (email) nameCandidate = removeOnce(nameCandidate, email);
  if (phone) nameCandidate = removeOnce(nameCandidate, phone);

  nameCandidate = cleanNameCandidate(nameCandidate)
    .replace(/\b(mi nombre es|soy|me llamo|name is|i am|hola|buenas|buenos|por favor|pls|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const name = nameCandidate ? parseFullName(nameCandidate) : null;
  return { name, email, phone };
}