import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../../lib/db";
import { sendWhatsApp } from "../../lib/senders/whatsapp";
import { sendSMS } from "../../lib/senders/sms";
import { sendEmail } from "../../lib/senders/email";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../../../public/uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

const CANAL_LIMITES: Record<string, number> = {
  whatsapp: 300,
  sms: 500,
  email: 1000,
};

// 📥 Obtener campañas del tenant
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

// 📊 Obtener uso mensual por canal
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

// 📊 Obtener estado de entregas SMS por campaña
router.get("/:id/sms-status", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      `SELECT to_number, status, error_code, error_message, timestamp
       FROM sms_status_logs
       WHERE tenant_id = $1 AND campaign_id = $2::int
       ORDER BY timestamp DESC`,
      [tenant_id, id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener logs SMS:", err);
    res.status(500).json({ error: "Error al obtener detalles de entrega." });
  }
});

// 📊 Obtener estado de entregas WhatsApp por campaña
router.get("/:id/whatsapp-status", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      `SELECT to_number, status, error_code, error_message, timestamp
       FROM whatsapp_status_logs
       WHERE tenant_id = $1 AND campaign_id = $2::int
       ORDER BY timestamp DESC`,
      [tenant_id, id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener logs WhatsApp:", err);
    res.status(500).json({ error: "Error al obtener detalles de entrega." });
  }
});

// 📤 Crear y enviar campaña
router.post("/", authenticateUser, upload.single("imagen"), async (req, res) => {
  try {
    const { nombre, canal, contenido, fecha_envio, segmentos } = req.body;
    const { tenant_id } = req.user as { uid: string; tenant_id: string };

    if (!nombre || !canal || !contenido || !fecha_envio || !segmentos) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    let segmentosParsed: string[] = [];

    try {
      segmentosParsed = typeof segmentos === "string" ? JSON.parse(segmentos) : segmentos;
      if (!Array.isArray(segmentosParsed)) {
        return res.status(400).json({ error: "Segmentos no tienen formato de lista." });
      }
    } catch (err) {
      console.error("❌ Error al parsear segmentos:", err);
      return res.status(400).json({ error: "El formato de los segmentos no es válido." });
    }

    const usoActual = await pool.query(
      `SELECT SUM(cantidad) AS total FROM campaign_usage
       WHERE tenant_id = $1 AND canal = $2 AND fecha_envio >= date_trunc('month', CURRENT_DATE)`,
      [tenant_id, canal]
    );

    const totalActual = parseInt(usoActual.rows[0]?.total || "0", 10);
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

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tenant no encontrado." });
    }

    const { twilio_number, twilio_sms_number, name: nombreNegocio } = result.rows[0];
    const imagen_url = req.file ? `/uploads/${req.file.filename}` : null;

    const campaignResult = await pool.query(
      `INSERT INTO campanas (
        tenant_id, titulo, contenido, imagen_url, canal, destinatarios, programada_para, enviada, fecha_creacion
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, true, NOW()
      ) RETURNING id`,
      [
        tenant_id,
        nombre,
        contenido,
        imagen_url,
        canal,
        JSON.stringify(segmentosParsed),
        fecha_envio,
      ]
    );

    const campaignId = campaignResult.rows[0].id;

    if (canal === "whatsapp") {
      if (!twilio_number) return res.status(400).json({ error: "Número de WhatsApp no asignado." });

      // ✅ Filtrar y mapear números válidos antes de enviar
      const contactos = segmentosParsed
        .filter((tel: string) => /^\+?\d{10,15}$/.test(tel.trim()))
        .map((tel: string) => ({ telefono: tel.trim() }));

      if (contactos.length === 0) {
        return res.status(400).json({ error: "No hay números válidos para enviar por WhatsApp." });
      }

      await sendWhatsApp(contenido, contactos, `whatsapp:${twilio_number}`, tenant_id, campaignId);

    } else if (canal === "sms") {
      if (!twilio_sms_number) return res.status(400).json({ error: "Número SMS no asignado." });
      await sendSMS(contenido, twilio_sms_number, tenant_id, campaignId);

    } else if (canal === "email") {
      await sendEmail(
        contenido,
        segmentosParsed.map((email: string) => ({ email })),
        nombreNegocio || "Tu negocio"
      );      

    } else {
      return res.status(400).json({ error: "Canal no válido." });
    }

    await pool.query(
      "INSERT INTO campaign_usage (tenant_id, canal, cantidad, fecha_envio) VALUES ($1, $2, $3, NOW())",
      [tenant_id, canal, segmentosParsed.length]
    );

    return res.status(200).json({ ok: true, message: "Campaña enviada correctamente." });
  } catch (error) {
    console.error("❌ Error al procesar campaña:", error);
    return res.status(500).json({ error: "Error interno al procesar la campaña." });
  }
});

// 🗑️ Eliminar campaña
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
