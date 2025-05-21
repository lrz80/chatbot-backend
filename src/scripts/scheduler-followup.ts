// src/scripts/scheduler-followup.ts

import pool from "../lib/db";
import { detectarIdioma } from "../lib/detectarIdioma";
import { traducirTexto } from "../lib/traducirTexto";
import { enviarWhatsApp } from "../lib/senders/whatsapp";

export async function enviarMensajesProgramados() {
  try {
    const ahora = new Date().toISOString();

    const res = await pool.query(
      `SELECT * FROM mensajes_programados
       WHERE enviado = false AND fecha_envio <= $1
       ORDER BY fecha_envio ASC
       LIMIT 10`,
      [ahora]
    );

    const mensajes = res.rows;

    for (const mensaje of mensajes) {
      try {
        // 🛡️ Marcamos como enviado primero para evitar duplicados si el proceso se repite
        await pool.query(
          `UPDATE mensajes_programados SET enviado = true WHERE id = $1`,
          [mensaje.id]
        );

        // 🧠 Buscar el último mensaje del usuario para detectar su idioma
        const ultimoMsg = await pool.query(
          `SELECT content FROM messages
           WHERE tenant_id = $1 AND canal = 'whatsapp' AND sender = 'user' AND from_number = $2
           ORDER BY timestamp DESC LIMIT 1`,
          [mensaje.tenant_id, mensaje.contacto]
        );

        const mensajeCliente = ultimoMsg.rows[0]?.content || mensaje.contenido;
        const idioma = await detectarIdioma(mensajeCliente);
        const contenidoTraducido = await traducirTexto(mensaje.contenido, idioma);

        await enviarWhatsApp(mensaje.contacto, contenidoTraducido, mensaje.tenant_id);

        console.log("✅ Seguimiento enviado a:", mensaje.contacto, "| Idioma:", idioma);
      } catch (err) {
        console.error("❌ Error al enviar seguimiento:", err);
        // Opcional: podrías revertir enviado = false si falló
      }
    }

    if (mensajes.length === 0) {
      console.log("📭 No hay mensajes pendientes.");
    }
  } catch (err) {
    console.error("❌ Error general en enviarMensajesProgramados:", err);
  }
}
