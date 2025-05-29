import pool from "../lib/db";
import { detectarIdioma } from "../lib/detectarIdioma";
import { traducirTexto } from "../lib/traducirTexto";
import { enviarWhatsApp } from "../lib/senders/whatsapp";

// 🕒 Scheduler de mensajes programados para follow-up
async function enviarMensajesProgramados() {
  const ahora = new Date().toISOString();

  try {
    const res = await pool.query(
      `SELECT * FROM mensajes_programados
       WHERE enviado = false AND fecha_envio <= $1
       ORDER BY fecha_envio ASC
       LIMIT 10`,
      [ahora]
    );

    const mensajes = res.rows;

    if (mensajes.length === 0) {
      console.log("📭 No hay mensajes pendientes para enviar.");
      return;
    }

    for (const mensaje of mensajes) {
      try {
        // 🛡️ Marcar como enviado primero
        await pool.query(
          `UPDATE mensajes_programados SET enviado = true WHERE id = $1`,
          [mensaje.id]
        );

        // ❌ Validar canal
        if (mensaje.canal !== 'whatsapp') {
          console.warn(`❌ Canal no compatible: ${mensaje.canal}`);
          continue;
        }

        // ❌ Validar formato internacional del número
        if (!mensaje.contacto.startsWith('+')) {
          console.warn(`❌ Número inválido: ${mensaje.contacto}`);
          continue;
        }

        // 🧠 Detectar idioma (opcional)
        const ultimoMsg = await pool.query(
          `SELECT content FROM messages
           WHERE tenant_id = $1 AND canal = 'whatsapp' AND sender = 'user' AND from_number = $2
           ORDER BY timestamp DESC LIMIT 1`,
          [mensaje.tenant_id, mensaje.contacto]
        );

        const mensajeCliente = ultimoMsg.rows[0]?.content || mensaje.contenido;
        const idioma = await detectarIdioma(mensajeCliente);
        const contenidoTraducido = await traducirTexto(mensaje.contenido, idioma);

        // 📤 Enviar mensaje
        await enviarWhatsApp(mensaje.contacto, contenidoTraducido, mensaje.tenant_id);
        console.log(`✅ Mensaje enviado a ${mensaje.contacto} (idioma: ${idioma})`);
      } catch (error) {
        console.error(`❌ Error enviando mensaje a ${mensaje.contacto}:`, error);
      }
    }
  } catch (err) {
    console.error("❌ Error general en enviarMensajesProgramados:", err);
  }
}

// 🕒 Scheduler corriendo cada minuto
setInterval(() => {
  enviarMensajesProgramados();
}, 60000);

console.log("⏰ Scheduler de follow-up corriendo cada minuto...");
