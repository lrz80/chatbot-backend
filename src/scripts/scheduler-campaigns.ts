// src/scripts/scheduler-campaigns.ts
import dotenv from "dotenv";
import path from "path";
import express from "express";

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
}

import pool from "../lib/db";
import { sendSMS } from "../lib/senders/sms";
import { sendWhatsApp } from "../lib/senders/whatsapp";
import { sendEmailSendgrid } from "../lib/senders/email-sendgrid";

// ===============================
// Helpers
// ===============================
type Canal = "sms" | "whatsapp" | "email";

type CampaignRow = {
  id: number;
  tenant_id: string;
  canal: Canal;
  contenido: string;
  destinatarios: string | null;
  programada_para: string | Date;

  // columnas nuevas
  status?: string | null;
  locked_at?: string | null;
  locked_by?: string | null;
  sent_at?: string | null;

  // legacy/compat
  enviada?: boolean | null;

  // email/media
  imagen_url?: string | null;
  link_url?: string | null;
  asunto?: string | null;
  titulo_visual?: string | null;

  // whatsapp templates
  template_sid?: string | null;
  template_vars?: any;
};

function getWorkerId() {
  return process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_STATIC_URL || `pid-${process.pid}`;
}

function asInt(n: any, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : fallback;
}

// ===============================
// plan_limits (desde tenants.plan_limits)
// ===============================
type Limits = {
  sms: number;
  whatsapp: number;
  email: number;
};

function parsePlanLimits(raw: any): Limits | null {
  if (!raw) return null;

  let obj: any = null;

  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  } else if (typeof raw === "object") {
    obj = raw;
  } else {
    return null;
  }

  // soporta {campaigns:{...}} o root directo
  const root = obj?.campaigns && typeof obj.campaigns === "object" ? obj.campaigns : obj;

  const sms = root?.sms ?? root?.sms_limit ?? root?.limit_sms ?? root?.base_sms;
  const whatsapp =
    root?.whatsapp ?? root?.whatsapp_limit ?? root?.limit_whatsapp ?? root?.base_whatsapp;
  const email = root?.email ?? root?.email_limit ?? root?.limit_email ?? root?.base_email;

  if (sms == null && whatsapp == null && email == null) return null;

  return {
    sms: asInt(sms, 0),
    whatsapp: asInt(whatsapp, 0),
    email: asInt(email, 0),
  };
}

// cache para no pegarle a DB por tenant cada 5 segundos
const LIMITS_CACHE_TTL_MS = 5 * 60 * 1000;
const limitsCache = new Map<string, { at: number; val: Limits | null }>();

async function getBaseLimitsFromTenant(tenantId: string): Promise<Limits | null> {
  const cached = limitsCache.get(tenantId);
  if (cached && Date.now() - cached.at <= LIMITS_CACHE_TTL_MS) return cached.val;

  const { rows } = await pool.query(
    `SELECT plan_limits
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );

  const raw = rows?.[0]?.plan_limits ?? null;
  const parsed = parsePlanLimits(raw);

  limitsCache.set(tenantId, { at: Date.now(), val: parsed });
  return parsed;
}

// ===============================
// Cupo dinámico por canal = base(tenants.plan_limits) + créditos vigentes - usados del mes
// ===============================
async function getCapacidadCanal(tenantId: string, canal: Canal) {
  const baseLimits = await getBaseLimitsFromTenant(tenantId);
  const base = baseLimits ? (baseLimits[canal] ?? 0) : 0;

  const { rows: urows } = await pool.query(
    `
    SELECT COALESCE(SUM(cantidad),0)::int AS usados
    FROM campaign_usage
    WHERE tenant_id = $1
      AND canal = $2
      AND fecha_envio >= date_trunc('month', CURRENT_DATE)
    `,
    [tenantId, canal]
  );
  const usados = asInt(urows[0]?.usados, 0);

  const { rows: crows } = await pool.query(
    `
    SELECT COALESCE(SUM(cantidad),0)::int AS extra_vigente
    FROM creditos_comprados
    WHERE tenant_id = $1
      AND canal = $2
      AND NOW() <= fecha_vencimiento
    `,
    [tenantId, canal]
  );
  const extraVigente = asInt(crows[0]?.extra_vigente, 0);

  const limite = base + extraVigente;
  const restante = Math.max(limite - usados, 0);

  return { base, extraVigente, usados, limite, restante, baseLimits };
}

// ===============================
// Claim campaigns (robusto con TTL)
// ===============================
async function claimCampaigns(limit = 10): Promise<CampaignRow[]> {
  const wid = getWorkerId();

  const { rows } = await pool.query(
    `
    WITH picked AS (
      SELECT id
      FROM campanas
      WHERE status = 'pending'
        AND programada_para <= NOW()
        AND (
          locked_at IS NULL
          OR locked_at < NOW() - INTERVAL '10 minutes'
        )
      ORDER BY programada_para ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE campanas c
       SET status = 'processing',
           locked_at = NOW(),
           locked_by = $2
      FROM picked
     WHERE c.id = picked.id
    RETURNING c.*
    `,
    [limit, wid]
  );

  return rows as CampaignRow[];
}

async function finalizeSent(campaignId: number) {
  await pool.query(
    `
    UPDATE campanas
       SET status='sent',
           enviada=true,
           sent_at=NOW(),
           locked_at=NULL,
           locked_by=NULL
     WHERE id=$1
    `,
    [campaignId]
  );
}

async function finalizeRetry(campaignId: number, minutes = 5, note?: string) {
  await pool.query(
    `
    UPDATE campanas
       SET status='pending',
           locked_at=NULL,
           locked_by=NULL,
           programada_para = NOW() + ($2 || ' minutes')::interval
     WHERE id=$1
    `,
    [campaignId, String(minutes)]
  );
  if (note) console.warn(note);
}

async function finalizeFailed(campaignId: number, note?: string) {
  await pool.query(
    `
    UPDATE campanas
       SET status='failed',
           locked_at=NULL,
           locked_by=NULL
     WHERE id=$1
    `,
    [campaignId]
  );
  if (note) console.warn(note);
}

// ===============================
// Main worker
// ===============================
async function ejecutarCampañasProgramadas() {
  const campañas = await claimCampaigns(10);
  if (campañas.length === 0) return;

  for (const c of campañas) {
    const campaignId = Number(c.id);
    const tenantId = String(c.tenant_id);
    const canal = String(c.canal) as Canal;

    try {
      // Parse destinatarios
      let destinatarios: string[] = [];
      try {
        destinatarios = JSON.parse(c.destinatarios || "[]");
        if (!Array.isArray(destinatarios)) destinatarios = [];
      } catch {
        destinatarios = [];
      }

      if (destinatarios.length === 0) {
        await finalizeFailed(campaignId, `⚠️ Campaña #${campaignId}: destinatarios vacíos.`);
        continue;
      }

      // Límite dinámico (tenants.plan_limits + créditos - usados)
      const cap = await getCapacidadCanal(tenantId, canal);

      if (!cap.baseLimits) {
        await finalizeFailed(
          campaignId,
          `⛔️ Campaña #${campaignId}: tenants.plan_limits está vacío/ inválido para tenant=${tenantId}.`
        );
        continue;
      }

      if (cap.limite <= 0) {
        await finalizeFailed(
          campaignId,
          `⛔️ Campaña #${campaignId}: limite=0 para ${canal.toUpperCase()} (base=${cap.base}).`
        );
        continue;
      }

      if (cap.restante <= 0) {
        await finalizeRetry(
          campaignId,
          60,
          `⛔️ Límite mensual alcanzado ${canal.toUpperCase()} tenant=${tenantId} (limite=${cap.limite}, usados=${cap.usados}). Reintento 60min.`
        );
        continue;
      }

      // Envío parcial si excede restante
      let saltados = 0;
      if (destinatarios.length > cap.restante) {
        saltados = destinatarios.length - cap.restante;
        destinatarios = destinatarios.slice(0, cap.restante);
      }

      if (destinatarios.length === 0) {
        await finalizeRetry(campaignId, 60, `⚠️ Campaña #${campaignId}: 0 destinatarios tras aplicar tope.`);
        continue;
      }

      let enviados = 0;

      // ===============================
      // SMS
      // ===============================
      if (canal === "sms") {
        const tenantRes = await pool.query(
          "SELECT twilio_sms_number FROM tenants WHERE id = $1",
          [tenantId]
        );
        const from = tenantRes.rows[0]?.twilio_sms_number;
        if (!from) {
          await finalizeFailed(campaignId, `⚠️ No hay twilio_sms_number para tenant ${tenantId}`);
          continue;
        }
        enviados = await sendSMS(c.contenido, destinatarios, from, tenantId, campaignId);
      }

      // ===============================
      // WhatsApp (solo templates)
      // ===============================
      if (canal === "whatsapp") {
        const tenantRes = await pool.query(
          "SELECT twilio_number FROM tenants WHERE id = $1",
          [tenantId]
        );
        const from = tenantRes.rows[0]?.twilio_number;
        if (!from) {
          await finalizeFailed(campaignId, `⚠️ No hay twilio_number (WhatsApp) para tenant ${tenantId}`);
          continue;
        }

        const { template_sid, template_vars } = c;
        if (!template_sid) {
          await finalizeFailed(campaignId, `⚠️ Falta template_sid para WhatsApp en campaña #${campaignId}`);
          continue;
        }

        let vars: Record<string, any> = {};
        try {
          vars = typeof template_vars === "string" ? JSON.parse(template_vars) : (template_vars || {});
        } catch {
          vars = {};
        }

        const contactos = destinatarios.map((tel: string) => ({ telefono: tel }));
        await sendWhatsApp(template_sid, contactos, `whatsapp:${from}`, tenantId, campaignId, vars);
        enviados = contactos.length;
      }

      // ===============================
      // Email
      // ===============================
      if (canal === "email") {
        const tenantRes = await pool.query(
          "SELECT name, logo_url FROM tenants WHERE id = $1",
          [tenantId]
        );
        const nombreNegocio = tenantRes.rows[0]?.name || "Tu negocio";
        const logoUrl = tenantRes.rows[0]?.logo_url;

        const contactosRes = await pool.query(
          `SELECT email, nombre
             FROM contactos
            WHERE tenant_id = $1 AND email = ANY($2)`,
          [tenantId, destinatarios]
        );

        const contactos = contactosRes.rows.map((r: any) => ({
          email: r.email,
          nombre: r.nombre || "amigo/a",
        }));

        if (contactos.length === 0) {
          await finalizeFailed(campaignId, `⚠️ Campaña #${campaignId}: emails no existen en contactos.`);
          continue;
        }

        await sendEmailSendgrid(
          c.contenido,
          contactos,
          nombreNegocio,
          tenantId,
          campaignId,
          c.imagen_url || undefined,
          c.link_url || undefined,
          logoUrl,
          c.asunto || "📣 Nueva campaña de tu negocio",
          c.titulo_visual || ""
        );

        enviados = contactos.length;
      }

      if (!enviados || enviados <= 0) {
        await finalizeRetry(campaignId, 10, `⚠️ Campaña #${campaignId}: 0 enviados. Reintento 10min.`);
        continue;
      }

      // Registrar uso real del mes
      await pool.query(
        `INSERT INTO campaign_usage (tenant_id, canal, cantidad, fecha_envio)
         VALUES ($1, $2, $3, NOW())`,
        [tenantId, canal, enviados]
      );

      // uso_mensual (informativo)
      const { rows: rowsTenant } = await pool.query(
        `SELECT membresia_inicio FROM tenants WHERE id = $1`,
        [tenantId]
      );
      const membresiaInicio = rowsTenant[0]?.membresia_inicio;

      if (membresiaInicio) {
        const inicio = new Date(membresiaInicio);
        const now = new Date();
        const diffInMonths =
          (now.getFullYear() - inicio.getFullYear()) * 12 + (now.getMonth() - inicio.getMonth());

        const cicloInicio = new Date(inicio);
        cicloInicio.setMonth(inicio.getMonth() + diffInMonths);
        const cicloMes = cicloInicio.toISOString().split("T")[0];

        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, canal, mes) DO UPDATE
           SET usados = uso_mensual.usados + EXCLUDED.usados,
               limite = EXCLUDED.limite`,
          [tenantId, canal, cicloMes, enviados, cap.limite]
        );
      }

      await finalizeSent(campaignId);

      const detalleParcial =
        saltados > 0 ? ` | enviados ${enviados}, saltados ${saltados}` : ` | enviados ${enviados}`;
      console.log(
        `✅ Campaña #${campaignId} SENT (${canal.toUpperCase()}${detalleParcial}) plan_limits=${JSON.stringify(
          cap.baseLimits
        )}`
      );
    } catch (err: any) {
      console.error(`❌ Error procesando campaña #${campaignId}:`, err?.message || err);
      await finalizeRetry(campaignId, 10, `↩️ Campaña #${campaignId} reprogramada 10min por error.`).catch(
        () => {}
      );
    }
  }
}

// ===============================
// Loop seguro (anti-paralelo)
// ===============================
let running = false;

setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await ejecutarCampañasProgramadas();
  } finally {
    running = false;
  }
}, 60 * 1000);

console.log("🕒 Scheduler de campañas corriendo cada 1 minuto...");

// ===============================
// Health server (Railway)
// ===============================
const app = express();
const PORT = Number(process.env.PORT || 3001);

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "campaign-scheduler",
    worker: getWorkerId(),
    ts: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Scheduler activo en http://localhost:${PORT}`);
});
