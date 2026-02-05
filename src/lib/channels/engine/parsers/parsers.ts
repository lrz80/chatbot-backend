// backend/src/lib/channels/engine/parsers/parsers.ts

// 💳 Confirmación de pago (usuario)
export const PAGO_CONFIRM_REGEX =
  /^(?!.*\b(no|aun\s*no|todav[ií]a\s*no|not)\b).*?\b(pago\s*realizado|listo\s*el\s*pago|ya\s*pagu[eé]|he\s*paga(do|do)|payment\s*(done|made|completed)|i\s*paid|paid)\b/i;

// 🧾 Detectores básicos de datos
export const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const PHONE_REGEX = /(\+?\d[\d\s().-]{7,}\d)/;

export function extractPaymentLinkFromPrompt(promptBase: string): string | null {
  if (!promptBase) return null;

  // 1) Preferido: marcador LINK_PAGO:
  const tagged = promptBase.match(/LINK_PAGO:\s*(https?:\/\/\S+)/i);
  if (tagged?.[1]) return tagged[1].replace(/[),.]+$/g, "");

  // 2) Fallback: primer URL
  const any = promptBase.match(/https?:\/\/[^\s)]+/i);
  return any?.[0] ? any[0].replace(/[),.]+$/g, "") : null;
}

export function looksLikeBookingPayload(text: string) {
  const t = String(text || "");
  const hasEmail = EMAIL_REGEX.test(t);
  const hasDateTime = /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(t);
  const hasDateOnly = /\b\d{4}-\d{2}-\d{2}\b/.test(t);
  const hasTimeOnly = /^\s*\d{2}:\d{2}\s*$/.test(t);
  return hasEmail || hasDateTime || hasDateOnly || hasTimeOnly;
}

export function parsePickNumber(text: string): number | null {
  const t = String(text || "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function pickSelectedChannelFromText(
  text: string
): "whatsapp" | "instagram" | "facebook" | "multi" | null {
  const t = (text || "").trim().toLowerCase();

  if (/\b(los\s+tres|las\s+tres|todos|todas|all\s+three)\b/i.test(t)) return "multi";

  if (t === "whatsapp" || t === "wa") return "whatsapp";
  if (t === "instagram" || t === "ig") return "instagram";
  if (t === "facebook" || t === "fb") return "facebook";

  const hasWhats = /\bwhats(app)?\b/i.test(t);
  const hasInsta = /\binsta(gram)?\b/i.test(t);
  const hasFace  = /\b(face(book)?|fb)\b/i.test(t);

  const count = Number(hasWhats) + Number(hasInsta) + Number(hasFace);

  if (count >= 2) return "multi";
  if (hasWhats) return "whatsapp";
  if (hasInsta) return "instagram";
  if (hasFace) return "facebook";

  return null;
}

// Parse simple: soporta "Nombre Apellido email teléfono país"
export function parseDatosCliente(text: string) {
  const raw = (text || "").trim();
  if (!raw) return null;

  const email = raw.match(EMAIL_REGEX)?.[0] || null;
  const phoneRaw = raw.match(PHONE_REGEX)?.[0] || null;
  const telefono = phoneRaw ? phoneRaw.replace(/[^\d+]/g, "") : null;

  if (!email || !telefono) return null;

  // Quita email y teléfono del texto y lo que quede lo usamos para nombre/pais
  let rest = raw.replace(email, " ").replace(phoneRaw || "", " ");
  rest = rest.replace(/\s+/g, " ").trim();

  // Si vienen en orden: nombre (2 primeras palabras) + país (resto)
  const parts = rest.split(" ").filter(Boolean);
  if (parts.length < 3) return null;

  const nombre = parts.slice(0, 2).join(" ").trim(); // Nombre + Apellido
  const pais = parts.slice(2).join(" ").trim();

  if (!nombre || !pais) return null;

  return { nombre, email, telefono, pais };
}
