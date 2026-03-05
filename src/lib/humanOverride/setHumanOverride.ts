// backend/src/lib/humanOverride/setHumanOverride.ts
import pool from "../db";
import type { Canal } from "../detectarIntencion";
import { sendSmsToTenantPhone } from "../notifications/sendSmsToTenantPhone";
import { sendEmailToTenant } from "../notifications/sendEmailToTenant";

// ✅ TTL GLOBAL (si no pasas minutes)
// Ajusta a lo que quieras como política del sistema
const HUMAN_OVERRIDE_TTL_MINUTES_DEFAULT = 10;

// ✅ clamps para evitar TTL absurdo
const HUMAN_OVERRIDE_TTL_MINUTES_MIN = 1;
const HUMAN_OVERRIDE_TTL_MINUTES_MAX = 60;

function clampMinutes(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return HUMAN_OVERRIDE_TTL_MINUTES_DEFAULT;
  const rounded = Math.floor(v);
  if (rounded < HUMAN_OVERRIDE_TTL_MINUTES_MIN) return HUMAN_OVERRIDE_TTL_MINUTES_MIN;
  if (rounded > HUMAN_OVERRIDE_TTL_MINUTES_MAX) return HUMAN_OVERRIDE_TTL_MINUTES_MAX;
  return rounded;
}

export async function setHumanOverride(opts: {
  tenantId: string;
  canal: Canal;
  contacto: string;

  minutes?: number; // default GLOBAL
  reason?: string | null;
  source?: string; // "support_handoff" | "explicit_request" | ...
  customerPhone?: string | null;

  userMessage?: string | null;
  messageId?: string | null;
}) {
  const { tenantId, canal, contacto } = opts;
  const minutes = clampMinutes(opts.minutes);

  // 1) Lee estado actual para saber si ya estaba activo (con TTL vigente)
  const { rows: beforeRows } = await pool.query(
    `SELECT human_override, human_override_until
       FROM clientes
      WHERE tenant_id=$1 AND canal=$2 AND contacto=$3
      LIMIT 1`,
    [tenantId, canal, contacto]
  );

  const before = beforeRows[0] || null;
  const beforeUntil = before?.human_override_until ? new Date(before.human_override_until) : null;

  const wasActive =
    before?.human_override === true &&
    beforeUntil instanceof Date &&
    !Number.isNaN(beforeUntil.getTime()) &&
    beforeUntil.getTime() > Date.now();

  // 2) Activa/renueva TTL
  // ✅ IMPORTANTE: usa make_interval para evitar concatenaciones con strings
  await pool.query(
    `
    INSERT INTO clientes (tenant_id, canal, contacto, human_override, human_override_until, updated_at)
    VALUES ($1, $2, $3, true, NOW() + make_interval(mins => $4::int), NOW())
    ON CONFLICT (tenant_id, canal, contacto)
    DO UPDATE SET
      human_override = true,
      human_override_until = NOW() + make_interval(mins => $4::int),
      updated_at = NOW()
    `,
    [tenantId, canal, contacto, minutes]
  );

  // 3) Notificar SOLO si pasó de “no activo” -> “activo”
  if (!wasActive) {
    const reason = String(opts.reason || "").trim();
    const source = String(opts.source || "unknown").trim();

    const { rows: trows } = await pool.query(
      `SELECT name, telefono_negocio, email_negocio
         FROM tenants
        WHERE id=$1
        LIMIT 1`,
      [tenantId]
    );

    const t = trows[0] || {};
    const nombreNegocio = String(t?.name || "").trim();
    const telNegocio = String(t?.telefono_negocio || "").trim();
    const emailNegocio = String(t?.email_negocio || "").trim();

    const safeUserMsg = String(opts.userMessage || "").trim();
    const snippet = safeUserMsg ? safeUserMsg.slice(0, 240) : ""; // SMS friendly

    const msg =
      `🚨 Aamy: Cliente necesita asistencia\n` +
      (nombreNegocio ? `Negocio: ${nombreNegocio}\n` : "") +
      `Canal: ${canal}\n` +
      `ClienteID: ${contacto}\n` +
      (opts.customerPhone ? `From: ${opts.customerPhone}\n` : "") +
      (source ? `Source: ${source}\n` : "") +
      (reason ? `Motivo: ${reason}\n` : "") +
      (opts.messageId ? `MsgId: ${opts.messageId}\n` : "") +
      (snippet ? `Mensaje: "${snippet}"\n` : "") +
      `TTL: ${minutes} min`;

    const emailText =
      msg + (safeUserMsg.length > 240 ? `\n\nMensaje completo:\n${safeUserMsg}` : "");

    // SMS + Email best-effort
    if (telNegocio) {
      try {
        await sendSmsToTenantPhone({ tenantId, text: msg });
      } catch {}
    }

    if (emailNegocio) {
      try {
        await sendEmailToTenant({
          tenantId,
          subject: "Human override activado - Aamy",
          text: emailText,
        });
      } catch {}
    }
  }

  return { wasActive, activatedNow: !wasActive, minutes };
}