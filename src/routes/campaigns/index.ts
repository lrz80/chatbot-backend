import express from "express";
import multer from "multer";
import pool from "../../lib/db";
import { sendWhatsApp } from "../../lib/senders/whatsapp";
import { sendSMS } from "../../lib/senders/sms";
import { sendEmail } from "../../lib/senders/email";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();
const upload = multer();

router.get("/", authenticateUser, async (req, res) => {
    try {
      const { tenant_id } = req.user as { tenant_id: string };
      const result = await pool.query(
        "SELECT * FROM campanas WHERE tenant_id = $1 ORDER BY fecha_creacion DESC",
        [tenant_id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("❌ Error al obtener campañas:", err);
      res.status(500).json({ error: "Error al obtener campañas" });
    }
  });  

router.post("/", authenticateUser, upload.none(), async (req, res) => {
  try {
    const { nombre, canal, contenido, fecha_envio, segmentos } = req.body;
    const { tenant_id } = req.user as { uid: string; tenant_id: string };

    if (!nombre || !canal || !contenido || !fecha_envio || !segmentos) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const segmentosParsed = JSON.parse(segmentos);

    // 🔍 Obtener información del tenant
    const result = await pool.query(
      "SELECT twilio_number, twilio_sms_number, name FROM tenants WHERE id = $1",
      [tenant_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tenant no encontrado." });
    }

    const { twilio_number, twilio_sms_number, name: nombreNegocio } = result.rows[0];

    // 📲 Canal de envío
    switch (canal) {
      case "whatsapp": {
        if (!twilio_number) {
          return res.status(400).json({ error: "Número de WhatsApp no asignado." });
        }
        await sendWhatsApp(contenido, segmentosParsed, `whatsapp:${twilio_number}`);
        break;
      }

      case "sms": {
        if (!twilio_sms_number) {
          return res.status(400).json({ error: "Número SMS no asignado." });
        }
        await sendSMS(contenido, segmentosParsed, twilio_sms_number);
        break;
      }

      case "email": {
        await sendEmail(contenido, segmentosParsed, nombreNegocio || "Tu Negocio");
        break;
      }

      default:
        return res.status(400).json({ error: "Canal no válido." });
    }

    // 🗃️ Guardar campaña en la base de datos
    await pool.query(
      `INSERT INTO campanas (
        tenant_id, titulo, contenido, imagen_url, canal, destinatarios, programada_para, enviada, fecha_creacion
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, NOW()
      )`,
      [
        tenant_id,
        nombre,
        contenido,
        null, // imagen_url (aún no implementado)
        canal,
        JSON.stringify(segmentosParsed),
        fecha_envio,
        true
      ]
    );

    return res.status(200).json({ ok: true, message: "Campaña enviada correctamente." });
  } catch (error) {
    console.error("❌ Error en /campaigns:", error);
    return res.status(500).json({ error: "Error al procesar la campaña." });
  }
});

router.delete("/:id", authenticateUser, async (req, res) => {
    const { id } = req.params;
    const { tenant_id } = req.user as { tenant_id: string };
  
    try {
      const result = await pool.query(
        "DELETE FROM campanas WHERE id = $1 AND tenant_id = $2 RETURNING *",
        [id, tenant_id]
      );
  
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Campaña no encontrada o no autorizada." });
      }
  
      res.json({ ok: true });
    } catch (err) {
      console.error("❌ Error al eliminar campaña:", err);
      res.status(500).json({ error: "Error al eliminar campaña" });
    }
  });  

export default router;
