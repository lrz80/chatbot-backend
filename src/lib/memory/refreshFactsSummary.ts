// backend/src/lib/memory/refreshFactsSummary.ts
import pool from "../db";
import { setMemoryValue, getMemoryValue } from "../clientMemory";

type Canal = "whatsapp" | "facebook" | "instagram" | "sms" | "voice";

function safeLine(s: any) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function yn(v: any) {
  return v ? "sí" : "no";
}

/**
 * Construye un resumen corto y estable del cliente (memoria larga),
 * basado en DB + memoria ligera (last_intent / state_pago_humano).
 * No usa OpenAI (0 tokens). “ChatGPT-like” por coherencia y continuidad.
 */
export async function refreshFactsSummary(opts: {
  tenantId: string;
  canal: Canal;
  senderId: string;        // contactoNorm
  idioma: "es" | "en";
}) {
  const { tenantId, canal, senderId, idioma } = opts;

  // 1) Lee DB “clientes”
  let cliente: any = null;
  try {
    const { rows } = await pool.query(
      `SELECT nombre, email, telefono, pais, segmento, estado, human_override, updated_at
         FROM clientes
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
        LIMIT 1`,
      [tenantId, canal, senderId]
    );
    cliente = rows[0] || null;
  } catch {}

  // 2) Lee memoria ligera
  let preferredLang = await getMemoryValue<string>({
    tenantId, canal, senderId, key: "preferred_lang",
  }).catch(() => null);

  let lastIntent = await getMemoryValue<string>({
    tenantId, canal, senderId, key: "last_intent",
  }).catch(() => null);

  let pagoHumano = await getMemoryValue<"pago" | "humano">({
    tenantId, canal, senderId, key: "state_pago_humano",
  }).catch(() => null);

  // Normaliza
  preferredLang = (preferredLang === "en" ? "en" : "es");
  lastIntent = safeLine(lastIntent).toLowerCase() || "";
  const estado = safeLine(cliente?.estado).toLowerCase();
  const segmento = safeLine(cliente?.segmento).toLowerCase();

  // 3) Construye resumen (máx 8–10 líneas)
  const lines: string[] = [];

  if (idioma === "en") {
    lines.push(`Language: ${preferredLang}`);
    lines.push(`Contact: ${senderId}`);

    if (cliente?.nombre) lines.push(`Name: ${safeLine(cliente.nombre)}`);
    if (cliente?.pais) lines.push(`Country: ${safeLine(cliente.pais)}`);

    if (segmento) lines.push(`Segment: ${segmento}`);
    if (estado) lines.push(`State: ${estado}`);

    if (cliente?.human_override === true || pagoHumano === "humano") {
      lines.push(`Human takeover: yes`);
    } else {
      lines.push(`Human takeover: no`);
    }

    if (estado === "esperando_pago") lines.push(`Payment: link sent / awaiting payment`);
    if (estado === "pago_en_confirmacion") lines.push(`Payment: confirming`);

    if (lastIntent) lines.push(`Last intent: ${lastIntent}`);
  } else {
    lines.push(`Idioma: ${preferredLang}`);
    lines.push(`Contacto: ${senderId}`);

    if (cliente?.nombre) lines.push(`Nombre: ${safeLine(cliente.nombre)}`);
    if (cliente?.pais) lines.push(`País: ${safeLine(cliente.pais)}`);

    if (segmento) lines.push(`Segmento: ${segmento}`);
    if (estado) lines.push(`Estado: ${estado}`);

    const human = (cliente?.human_override === true || pagoHumano === "humano");
    lines.push(`Humano tomado: ${human ? "sí" : "no"}`);

    if (estado === "esperando_pago") lines.push(`Pago: link enviado / esperando pago`);
    if (estado === "pago_en_confirmacion") lines.push(`Pago: en confirmación`);

    if (lastIntent) lines.push(`Última intención: ${lastIntent}`);
  }

  // 4) Compacta y guarda
  const summary = lines
    .map(safeLine)
    .filter(Boolean)
    .slice(0, 10)
    .join("\n");

  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "facts_summary",
    value: summary,
  });

  return summary;
}
