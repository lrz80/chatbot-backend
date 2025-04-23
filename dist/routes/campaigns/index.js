"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const db_1 = __importDefault(require("../../lib/db"));
const whatsapp_1 = require("../../lib/senders/whatsapp");
const sms_1 = require("../../lib/senders/sms");
const email_1 = require("../../lib/senders/email");
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
const upload = (0, multer_1.default)();
router.post("/", auth_1.authenticateUser, upload.none(), async (req, res) => {
    try {
        const { nombre, canal, contenido, fecha_envio, segmentos } = req.body;
        const { tenant_id } = req.user;
        if (!nombre || !canal || !contenido || !fecha_envio || !segmentos) {
            return res.status(400).json({ error: "Faltan campos obligatorios." });
        }
        const segmentosParsed = JSON.parse(segmentos);
        // 🔍 Obtener números Twilio según canal
        const result = await db_1.default.query("SELECT twilio_number, twilio_sms_number FROM tenants WHERE id = $1", [tenant_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Tenant no encontrado." });
        }
        const { twilio_number, twilio_sms_number } = result.rows[0];
        // 📲 Canal de envío
        switch (canal) {
            case "whatsapp": {
                if (!twilio_number) {
                    return res.status(400).json({ error: "Número de WhatsApp no asignado." });
                }
                await (0, whatsapp_1.sendWhatsApp)(contenido, segmentosParsed, `whatsapp:${twilio_number}`);
                break;
            }
            case "sms": {
                if (!twilio_sms_number) {
                    return res.status(400).json({ error: "Número SMS no asignado." });
                }
                await (0, sms_1.sendSMS)(contenido, segmentosParsed, twilio_sms_number);
                break;
            }
            case "email": {
                await (0, email_1.sendEmail)(contenido, segmentosParsed);
                break;
            }
            default:
                return res.status(400).json({ error: "Canal no válido." });
        }
        return res.status(200).json({ ok: true, message: "Campaña enviada correctamente." });
    }
    catch (error) {
        console.error("❌ Error en /campaigns:", error);
        return res.status(500).json({ error: "Error al procesar la campaña." });
    }
});
exports.default = router;
