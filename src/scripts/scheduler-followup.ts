// src/scripts/scheduler-followup.ts
import pool from "../lib/db";
import { detectarIdioma } from "../lib/detectarIdioma";
// Usa la misma función que el resto del backend (ajusta si tu helper se llama distinto)
import { traducirMensaje } from "../lib/traducirMensaje";
import { enviarWhatsApp } from "../lib/senders/whatsapp";
import { enviarMetaSeguro } from "../lib/senders/meta"; // <- debe resolver canal 'facebook' | 'instagram'

async function enviarMensajesProgramados() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Tomamos y bloqueamos trabajos vencidos para este worker
    const { rows: items } = await client.query(
      `SELECT id, tenant_id, canal, contacto, contenido
         FROM mensajes_programados
        WHERE enviado = false
          AND fecha_envio <= NOW()
        ORDER BY fecha_envio ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED`
    );

    if (items.length === 0) {
      console.log("📭 No hay mensajes pendientes para enviar.");
      await client.query("COMMIT");
      return;
    }

    console.log(`🚚 Procesando ${items.length} follow-up(s)...`);

    for (const m of items) {
      try {
        // Detecta idioma del cliente a partir del último mensaje del usuario
        const { rows: lastRows } = await client.query(
          `SELECT content
             FROM messages
            WHERE tenant_id = $1
              AND canal = $2
              AND role = 'user'
              AND from_number = $3
            ORDER BY timestamp DESC
            LIMIT 1`,
          [m.tenant_id, m.canal, m.contacto]
        );

        const pista = lastRows[0]?.content || m.contenido;
        const idDet = await detectarIdioma(pista).catch(() => "es");
        const idiomaDestino: "es" | "en" =
          (idDet || "").toLowerCase().startsWith("en") ? "en" : "es";

        // Traduce el follow-up si no coincide con el idioma del cliente
        let contenido = m.contenido;
        try {
          const raw = await detectarIdioma(contenido);
          const norm = String(raw || "").toLowerCase().split(/[-_]/)[0];

          // Solo aceptamos idiomas soportados ↓↓
          const lang: "es" | "en" | null =
            norm === "en" ? "en" :
            norm === "es" ? "es" :
            null;

          if (lang && lang !== idiomaDestino) {
            contenido = await traducirMensaje(contenido, idiomaDestino);
          }
        } catch {
          /* sin bloqueo */
        }

        // Enviar según canal
        if (m.canal === "whatsapp") {
          // 👉 Deja que enviarWhatsApp decida cómo formatear según el proveedor (Twilio vs Cloud API)
          await enviarWhatsApp(m.contacto, contenido, m.tenant_id);
        } else if (m.canal === "instagram" || m.canal === "facebook") {

          // PSID esperado en contacto; el sender debe resolver access token por tenant_id
          await enviarMetaSeguro(m.canal, m.contacto, contenido, m.tenant_id);
        } else {
          console.warn(`⚠️ Canal no soportado: ${m.canal} — id=${m.id}`);
          continue;
        }

        // Marcar enviado (solo tras éxito) y setear sent_at
        await client.query(
          `UPDATE mensajes_programados
              SET enviado = true, sent_at = NOW()
            WHERE id = $1`,
          [m.id]
        );

        // Registrar en messages para que aparezca en el History
        await client.query(
          `INSERT INTO messages
             (tenant_id, role, content, timestamp, canal, from_number, message_id)
           VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [m.tenant_id, contenido, m.canal, m.contacto, `followup-${m.id}`]
        );

        // Contabiliza uso mensual de followup
        const { rows: tr } = await client.query(
          `SELECT membresia_inicio FROM tenants WHERE id = $1`,
          [m.tenant_id]
        );
        const inicio = tr[0]?.membresia_inicio ? new Date(tr[0].membresia_inicio) : null;
        if (inicio) {
          const now = new Date();
          const diffMonths =
            (now.getFullYear() - inicio.getFullYear()) * 12 +
            (now.getMonth() - inicio.getMonth());
          inicio.setMonth(inicio.getMonth() + diffMonths);
          const cicloMes = inicio.toISOString().split("T")[0];

          await client.query(
            `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
             VALUES ($1, 'followup', $2, 1)
             ON CONFLICT (tenant_id, canal, mes)
             DO UPDATE SET usados = uso_mensual.usados + 1`,
            [m.tenant_id, cicloMes]
          );
        }

        console.log(
          `✅ Enviado id=${m.id} canal=${m.canal} to=${m.contacto} idioma=${idiomaDestino}`
        );
      } catch (err: any) {
        console.error(
          `❌ Error enviando id=${m.id} canal=${m.canal} to=${m.contacto}:`,
          err?.message || err
        );
        // No marcamos enviado: quedará para reintentar en el próximo ciclo.
        // Si quieres evitar reintentos rápidos, puedes posponer 5 min:
        // await client.query(
        //   `UPDATE mensajes_programados SET fecha_envio = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
        //   [m.id]
        // );
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    // 🔧 Usar el MISMO client de la transacción
    try { await client.query("ROLLBACK"); } catch {}
    console.error("❌ Error general scheduler:", e);
  } finally {
    // @ts-ignore
    if (client?.release) client.release();
  }
}

// Ejecutar directamente (útil si lo llamas por cron/k8s job)
(async () => {
  await enviarMensajesProgramados();
  process.exit(0);
})();
