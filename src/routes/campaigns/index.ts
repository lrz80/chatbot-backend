// src/routes/campaigns/index.ts
import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import { sendEmailSendgrid, sendEmailWithTemplate } from "../../lib/senders/email-sendgrid";
import { subirArchivoAR2 } from "../../lib/r2/subirArchivoAR2";

// ====== Channel Gate (mantenimiento global/tenant) ======
const GLOBAL_ID = process.env.GLOBAL_CHANNEL_TENANT_ID || '00000000-0000-0000-0000-000000000001';

type Canal = 'whatsapp' | 'sms' | 'email';

function resolveEnabledFlag(row: any, canal: Canal) {
  if (canal === 'whatsapp') return !!row.whatsapp_enabled;
  if (canal === 'sms')      return !!row.sms_enabled;
  if (canal === 'email')    return !!row.email_enabled;
  return false;
}

function resolvePausedUntil(row: any, canal: Canal): Date | null {
  // Asegúrate de tener estas columnas en channel_settings
  // paused_until_whatsapp, paused_until_sms, paused_until_email (TIMESTAMP NULL)
  if (canal === 'whatsapp') return row.paused_until_whatsapp ? new Date(row.paused_until_whatsapp) : null;
  if (canal === 'sms')      return row.paused_until_sms ? new Date(row.paused_until_sms) : null;
  if (canal === 'email')    return row.paused_until_email ? new Date(row.paused_until_email) : null;
  return null;
}

/**
 * Regresa true si el canal está operativo considerando:
 *  - flags globales (fila GLOBAL_ID)
 *  - flags del tenant
 *  - paused_until global y por tenant
 * Reglas:
 *  - Si global está deshabilitado → bloquea siempre.
 *  - Si global está en pausa (ahora < paused_until_global) → bloquea siempre.
 *  - Si tenant deshabilita → bloquea.
 *  - Si tenant pausa → bloquea.
 */
async function isChannelAllowedForTenant(tenantId: string, canal: Canal) {
  const { rows } = await pool.query(
    `SELECT *
       FROM channel_settings
      WHERE tenant_id = $1 OR tenant_id = $2`,
    [tenantId, GLOBAL_ID]
  );

  const now = Date.now();
  const globalRow = rows.find(r => r.tenant_id === GLOBAL_ID) || {};
  const tenantRow = rows.find(r => r.tenant_id === tenantId) || {};

  // Global
  const globalEnabled = resolveEnabledFlag(globalRow, canal);
  const globalPausedUntil = resolvePausedUntil(globalRow, canal);
  const globalPaused = globalPausedUntil ? globalPausedUntil.getTime() > now : false;

  if (!globalEnabled || globalPaused) return false;

  // Tenant
  // Si no hay fila del tenant, por seguridad exige que exista y permita.
  // (Si prefieres permitir por defecto, cambia a: const tenantEnabled = tenantRow ? ... : true)
  if (!tenantRow || !resolveEnabledFlag(tenantRow, canal)) return false;

  const tenantPausedUntil = resolvePausedUntil(tenantRow, canal);
  const tenantPaused = tenantPausedUntil ? tenantPausedUntil.getTime() > now : false;

  return !tenantPaused;
}

const router = express.Router();

/** ============ Multer (subidas) ============ */
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

/** ============ Límite base por canal (se suma a créditos vigentes) ============ */
const CANAL_LIMITES: Record<string, number> = {
  whatsapp: 300,
  sms: 500,
  email: 2000,
};

/** ============ Helpers de límite dinámico ============ */
/**
 * Devuelve usados (mes actual), límite (base + extras vigentes) y restante.
 * Los extras se leen de creditos_comprados por canal y cuentan hasta la MISMA hora/min/seg del vencimiento.
 */
async function getCapacidadCanal(tenantId: string, canal: string) {
  const base = CANAL_LIMITES[canal] ?? 0;

  // usados del mes en campaign_usage
  const { rows: urows } = await pool.query(
    `
    SELECT COALESCE(SUM(cantidad),0)::int AS usados
    FROM campaign_usage
    WHERE tenant_id = $1
      AND canal = $2
      AND fecha_envio >= date_trunc('month', CURRENT_DATE)
    `,
    [tenantId, canal]
  );
  const usados = urows[0]?.usados ?? 0;

  // créditos vigentes
  const { rows: crows } = await pool.query(
    `
    SELECT COALESCE(SUM(cantidad),0)::int AS extra_vigente
    FROM creditos_comprados
    WHERE tenant_id = $1
      AND canal = $2
      AND NOW() <= fecha_vencimiento
    `,
    [tenantId, canal]
  );
  const extraVigente = crows[0]?.extra_vigente ?? 0;

  const limite = base + extraVigente;
  const restante = Math.max(limite - usados, 0);

  return { base, extraVigente, usados, limite, restante };
}

/** ============ GET campañas ============ */
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
      titulo_visual: row.titulo_visual || "",
    }));

    res.json(campañasNormalizadas);
  } catch (err) {
    console.error("❌ Error al obtener campañas:", err);
    res.status(500).json({ error: "Error al obtener campañas" });
  }
});

/** ============ POST campañas ============ */
router.post(
  "/",
  authenticateUser,
  upload.fields([{ name: "imagen", maxCount: 1 }]),
  manejarErroresMulter,
  async (req: Request, res: Response) => {
    try {
      const { nombre, canal, contenido, fecha_envio, segmentos, template_sid, template_vars } = req.body;
      const { tenant_id } = req.user as { uid: string; tenant_id: string };
      const asunto = req.body.asunto || "📣 Nueva campaña de tu negocio";
      const tituloVisual = req.body.titulo_visual || "";

      // 🛡️ Verifica membresía
      const estado = await pool.query(
        `SELECT membresia_activa, name, logo_url FROM tenants WHERE id = $1`,
        [tenant_id]
      );
      const tenantRow = estado.rows[0];
      if (!tenantRow?.membresia_activa) {
        return res.status(403).json({
          error: "Tu membresía está inactiva. No puedes programar campañas hasta reactivarla.",
        });
      }

      if (!nombre || !canal || !fecha_envio || !segmentos) {
        return res.status(400).json({ error: "Faltan campos obligatorios." });
      }

      // ✅ Gate unificado: global + tenant + pausas
      const canalName = (canal || '').toLowerCase() as Canal;
      const allowed = await isChannelAllowedForTenant(tenant_id, canalName);
      if (!allowed) {
        return res.status(403).json({ error: 'channel_blocked', canal: canalName });
      }

      // Parse segmentos desde string o array
      let segmentosParsed: any[] = [];
      try {
        segmentosParsed =
          typeof segmentos === "string" ? JSON.parse(segmentos) : Array.isArray(segmentos) ? segmentos : [];
        if (!Array.isArray(segmentosParsed)) {
          return res.status(400).json({ error: "Segmentos no tienen formato de lista." });
        }
      } catch (err) {
        console.error("❌ Error al parsear segmentos:", err);
        return res.status(400).json({ error: "El formato de los segmentos no es válido." });
      }

      // 🔐 Límite dinámico por canal
      const cap = await getCapacidadCanal(tenant_id, canal);
      const solicitados = segmentosParsed.length;

      if (cap.limite <= 0) {
        return res.status(403).json({
          error: `No tienes cupo para ${canal} este mes. Compra créditos para continuar.`,
        });
      }
      if (solicitados > cap.restante) {
        return res.status(403).json({
          error: `Tu cupo disponible es ${cap.restante} ${canal === "email" ? "emails" : "envíos"} este mes (límite ${cap.limite}, usados ${cap.usados}). Reduce la lista o compra más créditos.`,
        });
      }

      // ========= Manejo de assets (email) =========
      let imagen_url: string | null = null;
      let link_url: string | null = null;
      let logo_url: string | undefined = tenantRow.logo_url || undefined;

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };

      if (canal === "email") {
        if (files?.imagen?.[0]) {
          const file = files.imagen[0];
          const buffer = fs.readFileSync(file.path);
          const filename = `email-assets/${tenant_id}/${Date.now()}-${file.originalname}`;
          imagen_url = await subirArchivoAR2(filename, buffer, file.mimetype);
          fs.unlinkSync(file.path);
        }
        link_url = req.body.link_url || null;
      }

      // ========= Insert campaña =========
      const insertQuery =
        canal === "email"
          ? `INSERT INTO campanas (
               tenant_id, titulo, contenido, imagen_url,
               canal, destinatarios, programada_para, enviada, fecha_creacion,
               link_url, template_sid, template_vars, asunto, titulo_visual
             ) VALUES (
               $1, $2, $3, $4,
               $5, $6, $7, false, NOW(),
               $8, $9, $10, $11, $12
             ) RETURNING id`
          : `INSERT INTO campanas (
               tenant_id, titulo, contenido, canal, destinatarios,
               programada_para, enviada, fecha_creacion
             ) VALUES (
               $1, $2, $3, $4, $5,
               $6, false, NOW()
             ) RETURNING id`;

      const insertValues =
        canal === "email"
          ? [
              tenant_id,
              nombre,
              contenido,
              imagen_url,
              canal,
              JSON.stringify(segmentosParsed),
              fecha_envio,
              link_url,
              template_sid || null,
              template_vars || null,
              asunto,
              tituloVisual,
            ]
          : [tenant_id, nombre, contenido, canal, JSON.stringify(segmentosParsed), fecha_envio];

      const campaignResult = await pool.query(insertQuery, insertValues);
      const campaignId = campaignResult.rows[0].id;

      // ========= Registrar uso del mes =========
      await pool.query(
        "INSERT INTO campaign_usage (tenant_id, canal, cantidad, fecha_envio) VALUES ($1, $2, $3, NOW())",
        [tenant_id, canal, solicitados]
      );

      // ========= Envío inmediato para email (si aplica) =========
      if (canal === "email") {
        // `segmentosParsed` son etiquetas de segmentación → obtener emails
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
            tenantRow.name,
            tenant_id,
            campaignId
          );
        } else {
          await sendEmailSendgrid(
            contenido,
            contactos,
            tenantRow.name,
            tenant_id,
            campaignId,
            imagen_url ? `${process.env.DOMAIN_URL}${imagen_url}` : undefined,
            link_url || undefined,
            logo_url,
            asunto,
            tituloVisual
          );
        }
      }

      return res.status(200).json({
        ok: true,
        message: "✅ Campaña programada correctamente. Se enviará en el horario indicado.",
        id: campaignId,
        nombre,
        canal,
        contenido,
        imagen_url,
        programada_para: fecha_envio,
        asunto,
        titulo_visual: tituloVisual,
        link_url,
        enviada: false,
        fecha_creacion: new Date().toISOString(),
        limite_mes: cap.limite,
        usados_mes: cap.usados + solicitados,
        restante_mes: cap.limite - (cap.usados + solicitados),
      });
    } catch (error) {
      console.error("❌ Error al programar campaña:", error);
      return res.status(500).json({ error: "Error interno al programar la campaña." });
    }
  }
);

/** ============ DELETE campaña ============ */
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

/** ============ Estado de SMS por campaña ============ */
router.get("/:id/sms-status", authenticateUser, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      `SELECT 
         message_sid,
         to_number AS telefono,
         status,
         error_message,
         timestamp
       FROM sms_status_logs
       WHERE campaign_id = $1 AND tenant_id = $2
       ORDER BY timestamp DESC`,
      [id, tenant_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error al cargar estado de SMS:", error);
    res.status(500).json({ error: "Error al obtener estado de SMS" });
  }
});

export default router;
