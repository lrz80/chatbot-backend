import express from "express";
import multer from "multer";
import pool from "../../lib/db";
import { sendWhatsApp } from "../../lib/senders/whatsapp";
import { sendSMS } from "../../lib/senders/sms";
import { sendEmail } from "../../lib/senders/email";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();
const upload = multer();

const CANAL_LIMITES: Record<string, number> = {
  whatsapp: 300,
  sms: 500,
  email: 1000,
};

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

router.get("/usage", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  try {
    const result = await pool.query(
      `SELECT canal, SUM(cantidad) as total
       FROM campaign_usage
       WHERE tenant_id = $1 AND fecha_envio >= date_trunc('month', CURRENT_DATE)
       GROUP BY canal`,
      [tenant_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener uso de campañas:", err);
    res.status(500).json({ error: "Error al obtener uso de campañas" });
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

    // ✅ Verificar si excede el límite mensual por canal
    const usoActual = await pool.query(
      `SELECT SUM(cantidad) AS total FROM campaign_usage
       WHERE tenant_id = $1 AND canal = $2 AND fecha_envio >= date_trunc('month', CURRENT_DATE)`,
      [tenant_id, canal]
    );

    const totalActual = parseInt(usoActual.rows[0].total || "0", 10);
    const totalNuevo = totalActual + segmentosParsed.length;

    if (totalNuevo > CANAL_LIMITES[canal]) {
      return res.status(403).json({
        error: `Has alcanzado el límite mensual de ${CANAL_LIMITES[canal]} envíos para ${canal}.`,
      });
    }

    const result = await pool.query(
      "SELECT twilio_number, twilio_sms_number, name FROM tenants WHERE id = $1",
      [tenant_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tenant no encontrado." });
    }

    const { twilio_number, twilio_sms_number, name: nombreNegocio } = result.rows[0];

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
        null,
        canal,
        JSON.stringify(segmentosParsed),
        fecha_envio,
        true
      ]
    );

    await pool.query(
      "INSERT INTO campaign_usage (tenant_id, canal, cantidad) VALUES ($1, $2, $3)",
      [tenant_id, canal, segmentosParsed.length]
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
