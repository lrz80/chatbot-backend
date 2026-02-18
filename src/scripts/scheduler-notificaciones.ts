// src/scripts/verificar-notificaciones.ts
import pool from "../lib/db";
import { sendEmailSendgrid } from "../lib/senders/email-sendgrid";
import { sendSMSNotificacion } from "../lib/senders/smsNotificacion";
import express from "express";

const VERBOSE_USAGE_LOGS = process.env.VERBOSE_USAGE_LOGS === "true";

type Canal = "whatsapp" | "meta" | "followup" | "voz" | "sms" | "email";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toISODate(d: Date) {
  return d.toISOString().substring(0, 10);
}

/**
 * Retorna el inicio del ciclo mensual basado en el día de membresia_inicio.
 * Ej: si membresia_inicio es día 18, cada ciclo inicia el 18 (ajustando al último día del mes).
 */
function cycleMonthStart(membresiaInicio: Date, now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const cutoffDay = membresiaInicio.getDate();

  const lastDayThisMonth = new Date(year, month + 1, 0).getDate();
  const dayThisMonth = Math.min(cutoffDay, lastDayThisMonth);

  let start = new Date(year, month, dayThisMonth);

  if (now < start) {
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    const dayPrevMonth = Math.min(cutoffDay, prevMonthLastDay);
    start = new Date(year, month - 1, dayPrevMonth);
  }

  return start;
}

/**
 * Trae créditos activos (add-ons) por tenant para un canal dado en 1 query (evita N+1).
 */
async function loadActiveCreditsMap(canal: Canal) {
  const { rows } = await pool.query(
    `
    SELECT tenant_id, COALESCE(SUM(cantidad), 0)::int AS creditos
    FROM creditos_comprados
    WHERE canal = $1
      AND fecha_compra <= NOW()
      AND fecha_vencimiento >= NOW()
    GROUP BY tenant_id
    `,
    [canal]
  );

  const map = new Map<string, number>();
  for (const r of rows || []) {
    map.set(String(r.tenant_id), Number(r.creditos || 0));
  }
  return map;
}

/**
 * Trae el registro "más reciente" de uso_mensual por tenant para el canal,
 * junto con datos del tenant y un usuario (email/teléfono) para notificar.
 *
 * OJO: Si el mes "más reciente" no coincide con el ciclo calculado, se hace un fallback query
 * SOLO para ese tenant+mes (caso raro), pero mantiene el sistema correcto.
 */
async function loadTenantsUsageLatestByCanal(canal: Canal) {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT ON (u.tenant_id)
      u.tenant_id,
      u.usados,
      u.limite,
      u.mes,
      u.notificado_80,
      u.notificado_100,
      t.name AS tenant_name,
      t.telefono_negocio,
      t.email_negocio,
      t.membresia_inicio,
      usr.email AS user_email,
      usr.telefono AS user_phone
    FROM uso_mensual u
    JOIN tenants t ON u.tenant_id = t.id
    LEFT JOIN LATERAL (
      SELECT email, telefono
      FROM users
      WHERE tenant_id = u.tenant_id
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1
    ) usr ON true
    WHERE u.canal = $1
      AND u.limite IS NOT NULL
    ORDER BY u.tenant_id, u.mes DESC
    `,
    [canal]
  );

  return rows || [];
}

/**
 * Fallback: trae uso_mensual exacto para tenant+canal+mes (si el latest no coincide con el ciclo).
 */
async function loadUsageForCycle(tid: string, canal: Canal, mesISO: string) {
  const { rows } = await pool.query(
    `
    SELECT
      COALESCE(usados, 0)::int AS usados,
      COALESCE(limite, 0)::int AS limite,
      COALESCE(notificado_80, false) AS notificado_80,
      COALESCE(notificado_100, false) AS notificado_100
    FROM uso_mensual
    WHERE tenant_id = $1 AND canal = $2 AND mes = $3
    LIMIT 1
    `,
    [tid, canal, mesISO]
  );

  return rows?.[0] || null;
}

async function verificarNotificaciones() {
  console.log("🚨 Verificando límites de uso...");

  // Evita duplicados si hay 2 instancias del mismo servicio corriendo
  const lock = await pool.query(`SELECT pg_try_advisory_lock(987654321) AS locked`);
  if (!lock.rows[0]?.locked) {
    console.log("⏭️ Otro verificador ya está corriendo. Se omite este ciclo.");
    return;
  }

  try {
    // 1) Desactivar membresías vencidas (DB-only, rápido)
    await pool.query(`
      UPDATE tenants
      SET membresia_activa = false
      WHERE membresia_vigencia < NOW() AND membresia_activa = true
    `);
    console.log("🔄 Membresías vencidas actualizadas.");

    const canales: Canal[] = ["whatsapp", "meta", "followup", "voz", "sms", "email"];

    for (const canal of canales) {
      // 2) Cargar créditos activos en batch (1 query por canal)
      const creditosMap = await loadActiveCreditsMap(canal);

      // 3) Cargar “latest usage” por tenant (1 query por canal)
      const tenants = await loadTenantsUsageLatestByCanal(canal);

      if (!tenants.length) {
        if (VERBOSE_USAGE_LOGS) console.log(`ℹ️ No hay filas de uso_mensual para canal=${canal}`);
        continue;
      }

      // Dedupe extra (por si acaso)
      const procesados = new Set<string>();

      for (const tenant of tenants) {
        const tid = String(tenant.tenant_id);
        if (procesados.has(tid)) continue;
        procesados.add(tid);

        const fechaInicio: Date | null = tenant.membresia_inicio
          ? new Date(tenant.membresia_inicio)
          : null;

        if (!fechaInicio || Number.isNaN(fechaInicio.getTime())) {
          console.warn(`⛔️ Tenant ${tid} no tiene membresia_inicio válida`);
          continue;
        }

        // 4) Determinar ciclo actual (mes ISO)
        const cicloStart = cycleMonthStart(fechaInicio);
        const cicloISO = toISODate(cicloStart);

        // 5) Tomar usados/limite de la fila “latest” si coincide con el ciclo
        //    Si no coincide, fallback query específica (caso raro)
        let usadosRaw = Number(tenant.usados || 0);
        let limite = Number(tenant.limite || 0);
        let notificado_80 = Boolean(tenant.notificado_80);
        let notificado_100 = Boolean(tenant.notificado_100);

        const mesFila = String(tenant.mes || "");
        if (mesFila && mesFila !== cicloISO) {
          const exact = await loadUsageForCycle(tid, canal, cicloISO);
          if (!exact) {
            // No hay fila para este ciclo todavía → nada que notificar
            if (VERBOSE_USAGE_LOGS) {
              console.log(
                `ℹ️ ${tenant.tenant_name} (${canal}) sin fila de uso_mensual para mes=${cicloISO}`
              );
            }
            continue;
          }
          usadosRaw = Number(exact.usados || 0);
          limite = Number(exact.limite || 0);
          notificado_80 = Boolean(exact.notificado_80);
          notificado_100 = Boolean(exact.notificado_100);
        }

        // 6) Sumar créditos activos (add-ons)
        const creditos = Number(creditosMap.get(tid) || 0);
        limite += creditos;

        // 7) Normalizar unidades (voz: segundos -> minutos ceil)
        const usadosNormalizados = canal === "voz" ? Math.ceil(usadosRaw / 60) : usadosRaw;

        const limiteSeguro = Math.max(1, limite);
        const porcentaje = (usadosNormalizados / limiteSeguro) * 100;

        if (porcentaje < 80) {
          if (VERBOSE_USAGE_LOGS) {
            console.log(
              `🔕 ${tenant.tenant_name} (${canal}) consumo bajo (${porcentaje.toFixed(
                1
              )}%), no se notificará.`
            );
          }
          continue;
        }

        if (porcentaje >= 100 && notificado_100) {
          if (VERBOSE_USAGE_LOGS) {
            console.log(`🔕 ${tenant.tenant_name} (${canal}) ya notificado por 100%.`);
          }
          continue;
        }

        if (porcentaje >= 80 && porcentaje < 100 && notificado_80) {
          if (VERBOSE_USAGE_LOGS) {
            console.log(`🔕 ${tenant.tenant_name} (${canal}) ya notificado por 80%.`);
          }
          continue;
        }

        const asunto = `🚨 Alerta: Uso en ${canal.toUpperCase()} (${porcentaje.toFixed(1)}%)`;

        const mensajeTexto = `
Hola ${tenant.tenant_name},

Has usado ${usadosNormalizados} de ${limiteSeguro} en ${canal.toUpperCase()} en tu ciclo actual (${cicloISO}).
${porcentaje >= 100 ? "🚫 Has superado tu límite mensual." : "⚠️ Estás alcanzando tu límite mensual (80%+)."}

Te recomendamos aumentar el límite para evitar interrupciones.

Atentamente,
Aamy.ai
        `.trim();

        // 8) Email (si hay al menos un correo)
        const correo =
          typeof tenant.user_email === "string" && tenant.user_email.includes("@")
            ? tenant.user_email
            : null;

        if (correo) {
          const contactos = [{ email: correo, nombre: String(tenant.tenant_name || "") }];
          await sendEmailSendgrid(
            mensajeTexto,
            contactos,
            "Aamy.ai",
            String(tid),
            0,
            undefined,
            undefined,
            "https://aamy.ai/avatar-amy.png",
            asunto, // asunto SendGrid
            asunto // título visual
          );
          console.log(`📧 Email enviado a: ${correo}`);
          await sleep(200); // micro-throttle
        } else {
          console.warn(`❌ No se encontró user_email válido para ${tenant.tenant_name}`);
        }

        // 9) SMS (dedupe simple)
        const telefonos = [tenant.telefono_negocio, tenant.user_phone].filter(
          (t: unknown): t is string => typeof t === "string" && t.trim().length > 0
        );

        const enviadosSMS = new Set<string>();
        for (const tel of telefonos) {
          if (enviadosSMS.has(tel)) continue;
          enviadosSMS.add(tel);

          await sendSMSNotificacion(mensajeTexto, [tel]);
          console.log(`📲 SMS notificación enviado a: ${tel}`);
          await sleep(150); // micro-throttle
        }

        // 10) Marcar notificado en el ciclo actual
        const notificacionField = porcentaje >= 100 ? "notificado_100" : "notificado_80";

        // Importante: actualizar el mes del ciclo, no “el último”
        await pool.query(
          `
          UPDATE uso_mensual
          SET ${notificacionField} = TRUE
          WHERE tenant_id = $1 AND canal = $2 AND mes = $3
          `,
          [tid, canal, cicloISO]
        );
      }
    }

    console.log("✅ Verificación de notificaciones completada.");
  } finally {
    try {
      await pool.query(`SELECT pg_advisory_unlock(987654321)`);
    } catch (e) {
      console.error("⚠️ Error liberando advisory lock:", e);
    }
  }
}

/**
 * Loop “no-overlap”: espera a terminar antes de dormir 5 min.
 * (mejor que setInterval para jobs que pueden tardar)
 */
async function loop() {
  console.log("⏰ Scheduler de notificaciones corriendo...");
  while (true) {
    try {
      await verificarNotificaciones();
    } catch (err) {
      console.error("❌ Error en verificarNotificaciones:", err);
    }
    await sleep(5 * 60 * 1000);
  }
}

// Mini servidor para healthcheck
const app = express();
const PORT = Number(process.env.PORT || 3002);

app.get("/", (_req, res) => {
  res.send("🟢 Verificador de notificaciones activo");
});

app.listen(PORT, () => {
  console.log(`🚀 Healthcheck en http://localhost:${PORT}`);
});

// Arrancar loop
void loop();
