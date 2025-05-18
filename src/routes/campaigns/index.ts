// src/routes/campaigns/index.ts

import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import { sendEmailSendgrid, sendEmailWithTemplate } from "../../lib/senders/email-sendgrid";
import { subirArchivoAR2 } from "../../lib/r2/subirArchivoAR2";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../../../public/uploads");
    console.log("📂 Guardando archivo en:", dir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  },
});

function manejarErroresMulter(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof multer.MulterError || err?.message?.includes("Unexpected field")) {
    console.error("❌ Error Multer:", err.message);
    return res.status(400).json({ error: "Error al subir archivo: " + err.message });
  }
  next(err);
}

const upload = multer({ storage });

const CANAL_LIMITES: Record<string, number> = {
  whatsapp: 300,
  sms: 500,
  email: 1000,
};

// ✅ GET /api/campaigns para obtener campañas
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const { tenant_id } = req.user as { tenant_id: string };
    const result = await pool.query(
      "SELECT * FROM campanas WHERE tenant_id = $1 ORDER BY fecha_creacion DESC",
      [tenant_id]
    );

    const campañasNormalizadas = result.rows.map((row) => ({
      id: row.id,
      titulo: row.titulo || row.nombre || "Sin nombre",
      contenido: row.contenido || "",
      canal: row.canal || "sms",
      destinatarios: (() => {
        try {
          return typeof row.destinatarios === "string"
            ? JSON.parse(row.destinatarios || "[]")
            : Array.isArray(row.destinatarios)
            ? row.destinatarios
            : [];
        } catch {
          return [];
        }
      })(),
      programada_para: row.programada_para || row.fecha_envio || null,
      enviada: row.enviada ?? true,
      fecha_creacion: row.fecha_creacion || new Date().toISOString(),
      imagen_url: row.imagen_url || null,
      link_url: row.link_url || "",
      asunto: row.asunto || "",
    }));

    res.json(campañasNormalizadas);
  } catch (err) {
    console.error("❌ Error al obtener campañas:", err);
    res.status(500).json({ error: "Error al obtener campañas" });
  }
});

// ✅ POST /api/campaigns para crear campañas
router.post(
  "/",
  authenticateUser,
  upload.fields([
    { name: "imagen", maxCount: 1 },
    { name: "archivo_adjunto", maxCount: 1 },
  ]),
  manejarErroresMulter,
  async (req: Request, res: Response) => {
    try {
      const { nombre, canal, contenido, fecha_envio, segmentos, template_sid, template_vars } = req.body;
      const { tenant_id } = req.user as { uid: string; tenant_id: string };
      const asunto = req.body.asunto || req.body["asunto"] || "📣 Nueva campaña de tu negocio";

      console.log("🧾 req.body completo:", req.body);
      console.log("📩 Asunto recibido:", asunto);

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
        "SELECT twilio_number, twilio_sms_number, name, logo_url FROM tenants WHERE id = $1",
        [tenant_id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Tenant no encontrado." });
      }
      
      let imagen_url = null;
      let archivo_adjunto_url = null;
      let link_url = null;
      let logo_url: string | undefined = result.rows[0].logo_url || undefined;

      const files = req.files as {
        [fieldname: string]: Express.Multer.File[];
      };

      if (canal === "email") {
        if (files?.imagen?.[0]) {
          const file = files.imagen[0];
          const buffer = fs.readFileSync(file.path);
          const filename = `email-assets/${tenant_id}/${Date.now()}-${file.originalname}`;
          imagen_url = await subirArchivoAR2(filename, buffer, file.mimetype);
          fs.unlinkSync(file.path);
        }

        if (files?.archivo_adjunto?.[0]) {
          const file = files.archivo_adjunto[0];
          const buffer = fs.readFileSync(file.path);
          const filename = `email-attachments/${tenant_id}/${Date.now()}-${file.originalname}`;
          archivo_adjunto_url = await subirArchivoAR2(filename, buffer, file.mimetype);
          fs.unlinkSync(file.path);
        }

        link_url = req.body.link_url || null;
      }

      const insertQuery = canal === "email"
        ? `INSERT INTO campanas (
            tenant_id, titulo, contenido, imagen_url, archivo_adjunto_url, canal, destinatarios, programada_para, enviada, fecha_creacion, link_url, template_sid, template_vars, asunto
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, false, NOW(), $9, $10, $11, $12
          ) RETURNING id`
        : `INSERT INTO campanas (
            tenant_id, titulo, contenido, canal, destinatarios, programada_para, enviada, fecha_creacion
          ) VALUES (
            $1, $2, $3, $4, $5, $6, false, NOW()
          ) RETURNING id`;

      const insertValues = canal === "email"
        ? [
            tenant_id,
            nombre,
            contenido,
            imagen_url,
            archivo_adjunto_url,
            canal,
            JSON.stringify(segmentosParsed),
            fecha_envio,
            link_url,
            template_sid || null,
            template_vars || null,
            asunto || "📣 Nueva campaña de tu negocio"
          ]
        : [
            tenant_id,
            nombre,
            contenido,
            canal,
            JSON.stringify(segmentosParsed),
            fecha_envio,
          ];

      const campaignResult = await pool.query(insertQuery, insertValues);

      await pool.query(
        "INSERT INTO campaign_usage (tenant_id, canal, cantidad, fecha_envio) VALUES ($1, $2, $3, NOW())",
        [tenant_id, canal, segmentosParsed.length]
      );

      if (canal === "email") {
        const contactosRes = await pool.query(
          `SELECT email, nombre FROM contactos WHERE tenant_id = $1 AND segmento = ANY($2)`,
          [tenant_id, segmentosParsed]
        );
        const contactos = contactosRes.rows || [];

        if (template_sid) {
          const parsedVars = template_vars ? JSON.parse(template_vars) : {};

          const enrichedContactos = contactos.map((c) => ({
            email: c.email,
            vars: {
              nombre: c.nombre || "amigo/a",
              ...parsedVars,
            },
          }));

          await sendEmailWithTemplate(
            enrichedContactos,
            template_sid,
            result.rows[0].name,
            tenant_id,
            campaignResult.rows[0].id
          );
        } else {
          await sendEmailSendgrid(
            contenido,
            contactos,
            result.rows[0].name,
            tenant_id,
            campaignResult.rows[0].id,
            imagen_url ? `${process.env.DOMAIN_URL}${imagen_url}` : undefined,
            link_url,
            logo_url,
            asunto
          );
        }
      }

      return res.status(200).json({
        ok: true,
        message: "✅ Campaña programada correctamente. Se enviará en el horario indicado.",
        id: campaignResult.rows[0].id,
        nombre,
        canal,
        contenido,
        imagen_url,
        archivo_adjunto_url,
        programada_para: fecha_envio,
        asunto,
        link_url,
        enviada: false,
        fecha_creacion: new Date().toISOString()
      });
    } catch (error) {
      console.error("❌ Error al programar campaña:", error);
      return res.status(500).json({ error: "Error interno al programar la campaña." });
    }
  }
);

// ✅ DELETE /api/campaigns/:id para eliminar una campaña completa
router.delete("/:id", authenticateUser, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      "SELECT * FROM campanas WHERE id = $1 AND tenant_id = $2",
      [id, tenant_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Campaña no encontrada o no pertenece a tu cuenta." });
    }

    const campaña = result.rows[0];

    const eliminarArchivo = (relativePath: string | null) => {
      if (!relativePath) return;
      const fullPath = path.join(__dirname, "../../../public", relativePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log("🗑 Archivo eliminado:", fullPath);
      }
    };

    eliminarArchivo(campaña.imagen_url);
    eliminarArchivo(campaña.archivo_adjunto_url);

    await pool.query("DELETE FROM campanas WHERE id = $1 AND tenant_id = $2", [id, tenant_id]);

    await pool.query(
      "DELETE FROM campaign_usage WHERE tenant_id = $1 AND fecha_envio = $2 AND canal = $3",
      [tenant_id, campaña.programada_para, campaña.canal]
    );

    return res.status(200).json({
      success: true,
      id: campaña.id,
      message: "✅ Campaña eliminada correctamente.",
    });
  } catch (error) {
    console.error("❌ Error al eliminar campaña:", error);
    return res.status(500).json({ error: "Error al eliminar campaña." });
  }
});

export default router;
