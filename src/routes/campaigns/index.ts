import express from "express";
import multer from "multer";
import pool from "@/lib/db";
import { sendWhatsApp } from "@/lib/senders/whatsapp";
import { sendSMS } from "@/lib/senders/sms";
import { sendEmail } from "@/lib/senders/email";
import authenticateUser from "@/middleware/auth";

const router = express.Router();
const upload = multer(); // para FormData

router.post("/", authenticateUser, upload.none(), async (req, res) => {
  try {
    const { nombre, canal, contenido, fecha_envio, segmentos } = req.body;
    const { tenant_id } = req.user;

    if (!nombre || !canal || !contenido || !fecha_envio || !segmentos) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const segmentosParsed = JSON.parse(segmentos);

    // 🔍 Obtener número Twilio del tenant
    const result = await pool.query(
      "SELECT twilio_number FROM tenants WHERE id = $1",
      [tenant_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tenant no encontrado." });
    }

    const tenantTwilioNumber = result.rows[0].twilio_number;

    if (!tenantTwilioNumber) {
      return res.status(400).json({ error: "Este tenant no tiene número de WhatsApp asignado." });
    }

    // Lógica por canal
    switch (canal) {
      case "whatsapp":
        await sendWhatsApp(contenido, segmentosParsed, `whatsapp:${tenantTwilioNumber}`);
        break;
      case "sms":
        await sendSMS(contenido, segmentosParsed, tenantTwilioNumber); // usarás número sms aquí
        break;
      case "email":
        await sendEmail(contenido, segmentosParsed);
        break;
      default:
        return res.status(400).json({ error: "Canal no válido." });
    }

    return res.status(200).json({ ok: true, message: "Campaña enviada correctamente." });
  } catch (error) {
    console.error("❌ Error en /campaigns:", error);
    return res.status(500).json({ error: "Error al procesar la campaña." });
  }
});

export default router;
