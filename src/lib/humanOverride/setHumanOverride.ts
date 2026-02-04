// backend/src/lib/humanOverride/setHumanOverride.ts
import pool from "../db";
import type { Canal } from "../detectarIntencion";
import { sendSmsToTenantPhone } from "../notifications/sendSmsToTenantPhone";
import { sendEmailToTenant } from "../notifications/sendEmailToTenant";

export async function setHumanOverride(opts: {
  tenantId: string;
  canal: Canal;
  contacto: string;

  minutes?: number; // default 5
  reason?: string | null;
  source?: string; // "emotion" | "payment" | ...
  customerPhone?: string | null;

  userMessage?: string | null;   // ✅ NUEVO: texto inbound del cliente
  messageId?: string | null;     // ✅ opcional
}) {
  const { tenantId, canal, contacto } = opts;
  const minutes = typeof opts.minutes === "number" ? opts.minutes : 5;

  // 1) Lee estado actual para saber si ya estaba activo
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
    beforeUntil &&
    beforeUntil.getTime() > Date.now();

  // 2) Activa/renueva TTL
  await pool.query(
    `
    INSERT INTO clientes (tenant_id, canal, contacto, human_override, human_override_until, updated_at)
    VALUES ($1, $2, $3, true, NOW() + ($4 || ' minutes')::interval, NOW())
    ON CONFLICT (tenant_id, canal, contacto)
    DO UPDATE SET
      human_override = true,
      human_override_until = NOW() + ($4 || ' minutes')::interval,
      updated_at = NOW()
    `,
    [tenantId, canal, contacto, String(minutes)]
  );

  // 3) Notificar SOLO si pasó de “no activo” -> “activo”
  if (!wasActive) {
    const reason = (opts.reason || "").trim();
    const source = (opts.source || "unknown").trim();

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
    (reason ? `Motivo: ${reason}\n` : "") +
    (opts.messageId ? `MsgId: ${opts.messageId}\n` : "") +
    (snippet ? `Mensaje: "${snippet}"\n` : "") +
    `TTL: ${minutes} min`;

    const emailText =
      msg +
      (safeUserMsg.length > 240 ? `\n\nMensaje completo:\n${safeUserMsg}` : "");
    // SMS + Email best-effort (no rompas el flujo)
    if (telNegocio) {
      try { await sendSmsToTenantPhone({ tenantId, toPhone: telNegocio, text: msg }); } catch {}
    }
    if (emailNegocio) {
      try {
        await sendEmailToTenant({
        tenantId,
        toEmail: emailNegocio,
        subject: "Human override activado - Aamy",
        text: emailText,
        });
      } catch {}
    }
  }

  return { wasActive, activatedNow: !wasActive };
}
