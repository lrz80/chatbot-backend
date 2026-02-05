// backend/src/lib/analytics/capiEvents.ts
import crypto from "crypto";
import type poolType from "../db";
import { sendCapiEvent } from "../../services/metaCapi";

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");

// ✅ DEDUPE 7 días (bucket estable). No depende de timezone.
function bucket7DaysUTC(d = new Date()) {
  const ms = d.getTime();
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  return `b7:${Math.floor(ms / windowMs)}`;
}

// ✅ Reserva dedupe en DB usando interactions (unique tenant+canal+message_id)
export async function reserveCapiEvent(pool: typeof poolType, tenantId: string, eventId: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, 'meta_capi', $2, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, eventId]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e: any) {
    console.warn("⚠️ reserveCapiEvent failed:", e?.message);
    return false;
  }
}

/**
 * Evento #1 (PRO): Lead solo primer mensaje del contacto.
 * Dedupe: depende de ensureClienteBase (isNewLead).
 */
export async function capiLeadFirstInbound(opts: {
  pool: typeof poolType;
  tenantId: string;
  canal: "whatsapp" | "facebook" | "instagram";
  contactoNorm: string;
  fromNumber?: string | null;
  messageId?: string | null;
  preview?: string | null;
  isNewLead: boolean;
}) {
  const { tenantId, canal, contactoNorm, fromNumber, messageId, preview, isNewLead } = opts;

  if (!isNewLead) return;

  try {
    const raw = String(fromNumber || contactoNorm || "").trim();
    const phoneE164 = raw.replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "").trim();

    const phoneHash = sha256(phoneE164 || contactoNorm);
    const eventId = `lead:${tenantId}:${phoneHash}`;

    await sendCapiEvent({
      tenantId,
      eventName: "Lead",
      eventId,
      userData: {
        external_id: sha256(`${tenantId}:${contactoNorm}`),
        ...(phoneE164 ? { ph: sha256(phoneE164) } : {}),
      },
      customData: {
        channel: canal,
        source: "first_inbound_message",
        inbound_message_id: messageId || undefined,
        preview: (preview || "").slice(0, 80),
      },
    });

    console.log("✅ CAPI Lead enviado (primer mensaje):", { tenantId, canal, contactoNorm });
  } catch (e: any) {
    console.warn("⚠️ Error enviando CAPI Lead PRO:", e?.message);
  }
}

/**
 * Evento #2 (PRO): Qualified lead -> Contact (1 vez por contacto).
 * Reglas: esIntencionDeVenta && nivel>=2
 */
export async function capiContactQualified(opts: {
  pool: typeof poolType;
  tenantId: string;
  canal: "whatsapp" | "facebook" | "instagram";
  contactoNorm: string;
  fromNumber?: string | null;
  messageId?: string | null;
  finalIntent: string;
  finalNivel: number;
}) {
  const { pool, tenantId, canal, contactoNorm, fromNumber, messageId, finalIntent, finalNivel } = opts;

  try {
    const raw = String(fromNumber || contactoNorm || "").trim();
    const phoneE164 = raw.replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "").trim();
    const phoneHash = sha256(phoneE164 || contactoNorm);

    const eventId = `ql:${tenantId}:${phoneHash}`; // ✅ 1 vez en la vida

    const ok = await reserveCapiEvent(pool, tenantId, eventId);
    if (!ok) {
      console.log("⏭️ CAPI Contact deduped:", { tenantId, canal, contactoNorm, eventId });
      return;
    }

    await sendCapiEvent({
      tenantId,
      eventName: "Contact",
      eventId,
      userData: {
        external_id: sha256(`${tenantId}:${contactoNorm}`),
        ...(phoneE164 ? { ph: sha256(phoneE164) } : {}),
      },
      customData: {
        channel: canal,
        intent: finalIntent,
        interest_level: finalNivel,
        inbound_message_id: messageId,
      },
    });

    console.log("✅ CAPI Contact enviado:", { tenantId, canal, contactoNorm, finalIntent, finalNivel });
  } catch (e: any) {
    console.warn("⚠️ Error enviando CAPI Contact:", e?.message);
  }
}

/**
 * Evento #3 (Ultra-universal): Lead fuerte dedupe cada 7 días.
 * Dedupe: reserveCapiEvent() con bucket7DaysUTC().
 * Reglas: esIntencionDeVenta && nivel>=3
 */
export async function capiLeadStrongWeekly(opts: {
  pool: typeof poolType;
  tenantId: string;
  canal: "whatsapp" | "facebook" | "instagram";
  contactoNorm: string;
  fromNumber?: string | null;
  messageId?: string | null;
  finalIntent: string;
  finalNivel: number;
}) {
  const { pool, tenantId, canal, contactoNorm, fromNumber, messageId, finalIntent, finalNivel } = opts;

  try {
    const raw = String(fromNumber || contactoNorm || "").trim();
    const phoneE164 = raw.replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "").trim();
    const contactHash = sha256(phoneE164 || contactoNorm);

    const eventId = `leadstrong:${tenantId}:${contactHash}:${bucket7DaysUTC()}`;
    const ok = await reserveCapiEvent(pool, tenantId, eventId);

    if (!ok) {
      console.log("⏭️ CAPI Lead (#3 fuerte) deduped:", { tenantId, canal, contactoNorm, eventId });
      return;
    }

    await sendCapiEvent({
      tenantId,
      eventName: "Lead",
      eventId,
      userData: {
        external_id: sha256(`${tenantId}:${contactoNorm}`),
        ...(phoneE164 ? { ph: sha256(phoneE164) } : {}),
      },
      customData: {
        channel: canal,
        source: "sales_intent_strong",
        intent: finalIntent,
        interest_level: finalNivel,
        inbound_message_id: messageId || undefined,
      },
    });

    console.log("✅ CAPI Lead (#3 fuerte) enviado:", { tenantId, canal, contactoNorm, finalIntent, finalNivel, eventId });
  } catch (e: any) {
    console.warn("⚠️ Error enviando CAPI evento #3 Lead fuerte:", e?.message);
  }
}
