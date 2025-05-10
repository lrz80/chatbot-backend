// src/routes/campaigns/index.ts

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

function normalizarNumero(numero: string): string {
  const limpio = numero.replace(/\D/g, "");
  if (limpio.length === 10) return `+1${limpio}`;
  if (limpio.length === 11 && limpio.startsWith("1")) return `+${limpio}`;
  if (numero.startsWith("+")) return numero;
  return "";
}

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

router.post("/", authenticateUser, upload.single("imagen"), async (req, res) => {
  try {
    const { nombre, canal, contenido, fecha_envio, segmentos, template_sid, template_vars } = req.body;
    const { tenant_id } = req.user as { uid: string; tenant_id: string };

    if (!nombre || !canal || !fecha_envio || !segmentos) {
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
    const imagen_url = req.file && canal === "email" ? `/uploads/${req.file.filename}` : null;
    const link_url = canal === "email" ? req.body.link_url : null;

    const campaignResult = await pool.query(
      `INSERT INTO campanas (
        tenant_id, titulo, contenido, imagen_url, canal, destinatarios, programada_para, enviada, fecha_creacion, link_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, true, NOW(), $8
      ) RETURNING id`,
      [
        tenant_id,
        nombre,
        contenido,
        imagen_url,
        canal,
        JSON.stringify(segmentosParsed),
        fecha_envio,
        link_url,
      ]
    );    

    const campaignId = campaignResult.rows[0].id;

    if (canal.toLowerCase() === "whatsapp") {
      if (!twilio_number) return res.status(400).json({ error: "Número de WhatsApp no asignado." });

      const campanaRes = await pool.query(
        `SELECT template_sid, template_vars FROM campanas WHERE id = $1 AND tenant_id = $2`,
        [campaignId, tenant_id]
      );
      const campana = campanaRes.rows[0];
      if (!campana || !campana.template_sid) {
        return res.status(400).json({ error: "La campaña no tiene plantilla asignada." });
      }

      const contactos = segmentosParsed
        .map((tel: string) => normalizarNumero(tel.trim()))
        .filter((tel) => /^\+\d{11,15}$/.test(tel))
        .map((tel) => ({ telefono: tel }));

      if (contactos.length === 0) {
        return res.status(400).json({ error: "No hay números válidos para enviar por WhatsApp." });
      }

      let vars = {};
      try {
        vars = typeof campana.template_vars === "string"
          ? JSON.parse(campana.template_vars)
          : (campana.template_vars || {});
      } catch {
        console.warn("⚠️ template_vars mal formateado, usando objeto vacío.");
      }

      await sendWhatsApp(
        campana.template_sid,
        contactos,
        `whatsapp:${twilio_number}`,
        tenant_id,
        campaignId,
        vars
      );

    } else if (canal === "sms") {
      if (!twilio_sms_number) return res.status(400).json({ error: "Número SMS no asignado." });

      const numerosSMS = segmentosParsed
        .map((tel: string) => normalizarNumero(tel.trim()))
        .filter((tel) => /^\+\d{11,15}$/.test(tel));

      if (numerosSMS.length === 0) {
        return res.status(400).json({ error: "No hay números válidos para enviar por SMS." });
      }

      await sendSMS(contenido, numerosSMS, twilio_sms_number, tenant_id, campaignId);
      
    } else if (canal === "email") {
      const destinatarios = segmentosParsed
        .map((email: string) => email.trim())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        .map((email) => ({ email }));

        const campanaResult = await pool.query(
          "SELECT link_url FROM campanas WHERE id = $1 AND tenant_id = $2",
          [campaignId, tenant_id]
        );
        const campana = campanaResult.rows[0];
        
      if (destinatarios.length === 0) {
        return res.status(400).json({ error: "No hay correos válidos para enviar." });
      }

      await sendEmail(
        contenido,
        destinatarios,
        nombreNegocio || "Tu negocio",
        tenant_id,
        campaignId,
        imagen_url || undefined, // usa imagen si se cargó
        campana.link_url || undefined // si usas un campo link_url en la tabla campanas
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

// 🗑️ Eliminar campaña
router.delete("/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const campaignId = parseInt(id, 10);
  const { tenant_id } = req.user as { tenant_id: string };

  if (isNaN(campaignId)) {
    return res.status(400).json({ error: "ID inválido." });
  }

  try {
    const result = await pool.query(
      "DELETE FROM campanas WHERE id = $1 AND tenant_id = $2 RETURNING *",
      [campaignId, tenant_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Campaña no encontrada o no autorizada." });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error al eliminar campaña:", err);
    res.status(500).json({ error: "Error al eliminar campaña." });
  }
});

export default router;
