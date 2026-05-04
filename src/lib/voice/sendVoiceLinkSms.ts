// src/lib/voice/sendVoiceLinkSms.ts

import pool from "../db";
import { sendSMS } from "../senders/sms";
import { LinkType } from "./types";

export type SendVoiceLinkSmsInput = {
  tenantId: string;
  smsType: LinkType;
  callerRaw: string;
  callerE164: string | null;
  overrideDestE164?: string | null;
  smsFromCandidate?: string | null;
  brand: string;
};

export type SendVoiceLinkSmsResult =
  | {
      ok: true;
      toDest: string;
      smsFrom: string;
      body: string;
      linkName: string;
      linkUrl: string;
      sentCount: number;
    }
  | {
      ok: false;
      code:
        | "LINK_NOT_FOUND"
        | "INVALID_DESTINATION"
        | "SMS_FROM_MISSING"
        | "SMS_FROM_WHATSAPP_ONLY"
        | "SEND_FAILED";
      message: string;
    };

const LINK_SYNONYMS: Record<LinkType, string[]> = {
  reservar: ["reservar", "reserva", "agendar", "cita", "turno", "booking", "appointment"],
  comprar: ["comprar", "pagar", "checkout", "payment", "pay", "precio", "precios", "prices"],
  soporte: ["soporte", "support", "ticket", "ayuda", "whatsapp", "wa.me", "whats"],
  web: ["web", "sitio", "pagina", "página", "home", "website", "ubicacion", "ubicación", "location", "mapa", "maps", "google maps"],
};

function isValidE164(value?: string | null): value is string {
  return !!value && /^\+\d{10,15}$/.test(value);
}

async function resolveLinkByType(
  tenantId: string,
  smsType: LinkType
): Promise<{ nombre?: string; url?: string } | null> {
  const synonyms = LINK_SYNONYMS[smsType];
  const likeAny = synonyms.map((word) => `%${word}%`);

  const base = 3;
  const inPlaceholders = synonyms.map((_, i) => `lower($${base + i})`).join(", ");
  const likeBase = base + synonyms.length;
  const likeClauses = likeAny
    .map((_, i) => `lower(tipo) LIKE lower($${likeBase + i})`)
    .join(" OR ");

  const sql = `
    SELECT id, tipo, nombre, url
    FROM links_utiles
    WHERE tenant_id = $1
      AND (
        lower(tipo) = lower($2)
        OR lower(tipo) IN (${inPlaceholders})
        OR ${likeClauses}
      )
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const params = [tenantId, smsType, ...synonyms, ...likeAny];
  const { rows } = await pool.query(sql, params);

  return rows[0] || null;
}

export async function sendVoiceLinkSms(
  input: SendVoiceLinkSmsInput
): Promise<SendVoiceLinkSmsResult> {
  const chosen = await resolveLinkByType(input.tenantId, input.smsType);

  if (!chosen?.url) {
    return {
      ok: false,
      code: "LINK_NOT_FOUND",
      message: "No hay links_utiles configurados para el tipo solicitado.",
    };
  }

  const smsFrom = input.smsFromCandidate || "";
  const toDest =
    input.overrideDestE164 && isValidE164(input.overrideDestE164)
      ? input.overrideDestE164
      : input.callerE164;

  if (!isValidE164(toDest)) {
    return {
      ok: false,
      code: "INVALID_DESTINATION",
      message: `Número destino inválido: ${input.callerRaw} → ${toDest}`,
    };
  }

  if (!smsFrom) {
    return {
      ok: false,
      code: "SMS_FROM_MISSING",
      message: "No hay un número SMS-capable configurado.",
    };
  }

  if (smsFrom.startsWith("whatsapp:")) {
    return {
      ok: false,
      code: "SMS_FROM_WHATSAPP_ONLY",
      message: "Número configurado es WhatsApp-only; no envía SMS.",
    };
  }

  const body = `📎 ${chosen.nombre || "Enlace"}: ${chosen.url}\n— ${input.brand}`;

  try {
    const sentCount = await sendSMS({
      mensaje: body,
      destinatarios: [toDest],
      fromNumber: smsFrom,
      tenantId: input.tenantId,
      campaignId: null,
    });

    return {
      ok: true,
      toDest,
      smsFrom,
      body,
      linkName: chosen.nombre || "Enlace",
      linkUrl: chosen.url,
      sentCount,
    };
  } catch (error: any) {
    return {
      ok: false,
      code: "SEND_FAILED",
      message: error?.message || "Error enviando SMS.",
    };
  }
}