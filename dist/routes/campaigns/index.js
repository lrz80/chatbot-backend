"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const email_sendgrid_1 = require("../../lib/senders/email-sendgrid");
const subirArchivoAR2_1 = require("../../lib/r2/subirArchivoAR2");
const router = express_1.default.Router();
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => {
        const dir = path_1.default.join(__dirname, "../../../public/uploads");
        console.log("📂 Guardando archivo en:", dir);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + "-" + file.originalname;
        cb(null, uniqueName);
    },
});
function manejarErroresMulter(err, req, res, next) {
    if (err instanceof multer_1.default.MulterError || err?.message?.includes("Unexpected field")) {
        console.error("❌ Error Multer:", err.message);
        return res.status(400).json({ error: "Error al subir archivo: " + err.message });
    }
    next(err);
}
const upload = (0, multer_1.default)({ storage });
const CANAL_LIMITES = {
    whatsapp: 300,
    sms: 500,
    email: 1000,
};
// ✅ GET campañas
router.get("/", auth_1.authenticateUser, async (req, res) => {
    try {
        const { tenant_id } = req.user;
        const result = await db_1.default.query("SELECT * FROM campanas WHERE tenant_id = $1 ORDER BY fecha_creacion DESC", [tenant_id]);
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
                }
                catch {
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
    }
    catch (err) {
        console.error("❌ Error al obtener campañas:", err);
        res.status(500).json({ error: "Error al obtener campañas" });
    }
});
// ✅ POST campañas
router.post("/", auth_1.authenticateUser, upload.fields([
    { name: "imagen", maxCount: 1 },
]), manejarErroresMulter, async (req, res) => {
    try {
        const { nombre, canal, contenido, fecha_envio, segmentos, template_sid, template_vars } = req.body;
        const { tenant_id } = req.user;
        const asunto = req.body.asunto || "📣 Nueva campaña de tu negocio";
        const tituloVisual = req.body.titulo_visual || "";
        console.log("🧾 req.body completo:", req.body);
        if (!nombre || !canal || !fecha_envio || !segmentos) {
            return res.status(400).json({ error: "Faltan campos obligatorios." });
        }
        let segmentosParsed = [];
        try {
            segmentosParsed = typeof segmentos === "string" ? JSON.parse(segmentos) : segmentos;
            if (!Array.isArray(segmentosParsed)) {
                return res.status(400).json({ error: "Segmentos no tienen formato de lista." });
            }
        }
        catch (err) {
            console.error("❌ Error al parsear segmentos:", err);
            return res.status(400).json({ error: "El formato de los segmentos no es válido." });
        }
        const usoActual = await db_1.default.query(`SELECT SUM(cantidad) AS total FROM campaign_usage
         WHERE tenant_id = $1 AND canal = $2 AND fecha_envio >= date_trunc('month', CURRENT_DATE)`, [tenant_id, canal]);
        const totalActual = parseInt(usoActual.rows[0]?.total || "0", 10);
        const totalNuevo = totalActual + segmentosParsed.length;
        if (totalNuevo > CANAL_LIMITES[canal]) {
            return res.status(403).json({
                error: `Has alcanzado el límite mensual de ${CANAL_LIMITES[canal]} envíos para ${canal}.`,
            });
        }
        const result = await db_1.default.query("SELECT twilio_number, twilio_sms_number, name, logo_url FROM tenants WHERE id = $1", [tenant_id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Tenant no encontrado." });
        }
        let imagen_url = null;
        let archivo_adjunto_url = null;
        let link_url = null;
        let logo_url = result.rows[0].logo_url || undefined;
        const files = req.files;
        if (canal === "email") {
            if (files?.imagen?.[0]) {
                const file = files.imagen[0];
                const buffer = fs_1.default.readFileSync(file.path);
                const filename = `email-assets/${tenant_id}/${Date.now()}-${file.originalname}`;
                imagen_url = await (0, subirArchivoAR2_1.subirArchivoAR2)(filename, buffer, file.mimetype);
                fs_1.default.unlinkSync(file.path);
            }
            link_url = req.body.link_url || null;
        }
        const insertQuery = canal === "email"
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
        const insertValues = canal === "email"
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
            : [
                tenant_id,
                nombre,
                contenido,
                canal,
                JSON.stringify(segmentosParsed),
                fecha_envio
            ];
        const campaignResult = await db_1.default.query(insertQuery, insertValues);
        await db_1.default.query("INSERT INTO campaign_usage (tenant_id, canal, cantidad, fecha_envio) VALUES ($1, $2, $3, NOW())", [tenant_id, canal, segmentosParsed.length]);
        if (canal === "email") {
            const contactosRes = await db_1.default.query(`SELECT email, nombre FROM contactos WHERE tenant_id = $1 AND segmento = ANY($2)`, [tenant_id, segmentosParsed]);
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
                await (0, email_sendgrid_1.sendEmailWithTemplate)(enrichedContactos, template_sid, result.rows[0].name, tenant_id, campaignResult.rows[0].id);
            }
            else {
                await (0, email_sendgrid_1.sendEmailSendgrid)(contenido, contactos, result.rows[0].name, tenant_id, campaignResult.rows[0].id, imagen_url ? `${process.env.DOMAIN_URL}${imagen_url}` : undefined, link_url, logo_url, asunto, tituloVisual // 👈 nuevo argumento
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
            programada_para: fecha_envio,
            asunto,
            titulo_visual: tituloVisual,
            link_url,
            enviada: false,
            fecha_creacion: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("❌ Error al programar campaña:", error);
        return res.status(500).json({ error: "Error interno al programar la campaña." });
    }
});
// ✅ DELETE campaña
router.delete("/:id", auth_1.authenticateUser, async (req, res) => {
    const { id } = req.params;
    const { tenant_id } = req.user;
    try {
        const result = await db_1.default.query("SELECT * FROM campanas WHERE id = $1 AND tenant_id = $2", [id, tenant_id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Campaña no encontrada o no pertenece a tu cuenta." });
        }
        const campaña = result.rows[0];
        const eliminarArchivo = (relativePath) => {
            if (!relativePath)
                return;
            const fullPath = path_1.default.join(__dirname, "../../../public", relativePath);
            if (fs_1.default.existsSync(fullPath)) {
                fs_1.default.unlinkSync(fullPath);
                console.log("🗑 Archivo eliminado:", fullPath);
            }
        };
        eliminarArchivo(campaña.imagen_url);
        await db_1.default.query("DELETE FROM campanas WHERE id = $1 AND tenant_id = $2", [id, tenant_id]);
        await db_1.default.query("DELETE FROM campaign_usage WHERE tenant_id = $1 AND fecha_envio = $2 AND canal = $3", [tenant_id, campaña.programada_para, campaña.canal]);
        return res.status(200).json({
            success: true,
            id: campaña.id,
            message: "✅ Campaña eliminada correctamente.",
        });
    }
    catch (error) {
        console.error("❌ Error al eliminar campaña:", error);
        return res.status(500).json({ error: "Error al eliminar campaña." });
    }
});
// 🔽 Agrega esto al final del archivo de rutas de campañas
router.get("/:id/sms-status", auth_1.authenticateUser, async (req, res) => {
    const { id } = req.params;
    const { tenant_id } = req.user;
    try {
        const result = await db_1.default.query(`SELECT 
         message_sid,
         to_number AS telefono,
         status,
         error_message,
         timestamp
       FROM sms_status_logs
       WHERE campaign_id = $1 AND tenant_id = $2
       ORDER BY timestamp DESC`, [id, tenant_id]);
        res.json(result.rows);
    }
    catch (error) {
        console.error("❌ Error al cargar estado de SMS:", error);
        res.status(500).json({ error: "Error al obtener estado de SMS" });
    }
});
exports.default = router;
