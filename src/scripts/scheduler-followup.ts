// src/scripts/scheduler-followup.ts
import pool from "../lib/db";
import { detectarIdioma } from "../lib/detectarIdioma";
import { traducirMensaje } from "../lib/traducirMensaje";
import { enviarWhatsApp } from "../lib/senders/whatsapp";
import { enviarMetaSeguro } from "../lib/senders/meta";

type Canal = "whatsapp" | "facebook" | "instagram";

type Job = {
  id: string;
  tenant_id: string;
  canal: Canal;
  contacto: string;
  contenido: string;
};

function workerId() {
  return (
    process.env.RAILWAY_SERVICE_NAME ||
    process.env.RAILWAY_STATIC_URL ||
    `pid-${process.pid}`
  );
}

async function claimJobs(limit = 20): Promise<Job[]> {
  // Claim atómico: toma jobs vencidos y marca locked_at/locked_by
  const { rows } = await pool.query(
    `
    WITH picked AS (
      SELECT id
      FROM mensajes_programados
      WHERE enviado = false
        AND fecha_envio <= NOW()
        AND (
          locked_at IS NULL
          OR locked_at < NOW() - INTERVAL '10 minutes'
        )
      ORDER BY fecha_envio ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE mensajes_programados mp
       SET locked_at = NOW(),
           locked_by = $2
      FROM picked
     WHERE mp.id = picked.id
    RETURNING mp.id, mp.tenant_id, mp.canal, mp.contacto, mp.contenido
    `,
    [limit, workerId()]
  );

  return rows as Job[];
}

async function releaseJob(id: string) {
  await pool.query(
    `UPDATE mensajes_programados
        SET locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [id]
  );
}

async function markSuccessAndLog(job: Job, contenidoFinal: string) {
  await pool.query(
    `UPDATE mensajes_programados
        SET enviado = true, sent_at = NOW(), locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [job.id]
  );

  await pool.query(
    `INSERT INTO messages
       (tenant_id, role, content, timestamp, canal, from_number, message_id)
     VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
     ON CONFLICT (tenant_id, message_id) DO NOTHING`,
    [job.tenant_id, contenidoFinal, job.canal, job.contacto, `followup-${job.id}`]
  );

  // Contabiliza uso mensual de followup (igual que tenías, pero sin client transaccional)
  const { rows: tr } = await pool.query(
    `SELECT membresia_inicio FROM tenants WHERE id = $1`,
    [job.tenant_id]
  );

  const inicio = tr[0]?.membresia_inicio ? new Date(tr[0].membresia_inicio) : null;
  if (inicio) {
    const now = new Date();
    const diffMonths =
      (now.getFullYear() - inicio.getFullYear()) * 12 + (now.getMonth() - inicio.getMonth());
    inicio.setMonth(inicio.getMonth() + diffMonths);
    const cicloMes = inicio.toISOString().split("T")[0];

    await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
       VALUES ($1, 'followup', $2, 1)
       ON CONFLICT (tenant_id, canal, mes)
       DO UPDATE SET usados = uso_mensual.usados + 1`,
      [job.tenant_id, cicloMes]
    );
  }
}

async function postponeJob(jobId: string, minutes = 5) {
  await pool.query(
    `UPDATE mensajes_programados
        SET locked_at = NULL, locked_by = NULL,
            fecha_envio = NOW() + ($2 || ' minutes')::interval
      WHERE id = $1`,
    [jobId, String(minutes)]
  );
}

async function resolveIdiomaDestino(job: Job): Promise<"es" | "en"> {
  // Idioma a partir del último mensaje del usuario (si existe)
  const { rows: lastRows } = await pool.query(
    `SELECT content
       FROM messages
      WHERE tenant_id = $1
        AND canal = $2
        AND role = 'user'
        AND from_number = $3
      ORDER BY timestamp DESC
      LIMIT 1`,
    [job.tenant_id, job.canal, job.contacto]
  );

  const pista = lastRows[0]?.content || job.contenido;
  const idDet = await detectarIdioma(pista).catch(() => "es");
  return String(idDet || "").toLowerCase().startsWith("en") ? "en" : "es";
}

async function maybeTranslate(contenido: string, idiomaDestino: "es" | "en") {
  try {
    const raw = await detectarIdioma(contenido);
    const norm = String(raw || "").toLowerCase().split(/[-_]/)[0];

    const lang: "es" | "en" | null = norm === "en" ? "en" : norm === "es" ? "es" : null;

    if (lang && lang !== idiomaDestino) {
      return await traducirMensaje(contenido, idiomaDestino);
    }
  } catch {
    // ignore
  }
  return contenido;
}

async function sendByChannel(job: Job, contenidoFinal: string) {
  if (job.canal === "whatsapp") {
    await enviarWhatsApp(job.contacto, contenidoFinal, job.tenant_id);
    return;
  }
  if (job.canal === "instagram" || job.canal === "facebook") {
    await enviarMetaSeguro(job.canal, job.contacto, contenidoFinal, job.tenant_id);
    return;
  }
  throw new Error(`Canal no soportado: ${job.canal}`);
}

async function enviarMensajesProgramados() {
  const items = await claimJobs(20);

  if (items.length === 0) {
    console.log("📭 No hay mensajes pendientes para enviar.");
    return;
  }

  console.log(`🚚 Procesando ${items.length} follow-up(s)...`);

  for (const job of items) {
    try {
      const idiomaDestino = await resolveIdiomaDestino(job);
      const contenidoFinal = await maybeTranslate(job.contenido, idiomaDestino);

      await sendByChannel(job, contenidoFinal);
      await markSuccessAndLog(job, contenidoFinal);

      console.log(
        `✅ Enviado id=${job.id} canal=${job.canal} to=${job.contacto} idioma=${idiomaDestino}`
      );
    } catch (err: any) {
      console.error(
        `❌ Error enviando id=${job.id} canal=${job.canal} to=${job.contacto}:`,
        err?.message || err
      );

      // Evita reintentos inmediatos + libera lock
      await postponeJob(job.id, 5).catch(async () => {
        // fallback: al menos libera el lock
        await releaseJob(job.id).catch(() => {});
      });
    }
  }
}

// Ejecutar directamente (cron/job)
(async () => {
  try {
    await enviarMensajesProgramados();
  } catch (e) {
    console.error("❌ Error general scheduler:", e);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
