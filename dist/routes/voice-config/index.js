"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
const upload = (0, multer_1.default)();
// 📥 OBTENER configuración de voz
router.get("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    const { idioma = "es-ES", canal = "voz" } = req.query;
    try {
        const result = await db_1.default.query(`SELECT * FROM voice_configs
       WHERE tenant_id = $1 AND idioma = $2 AND canal = $3
       ORDER BY created_at DESC LIMIT 1`, [tenant_id, idioma, canal]);
        res.json(result.rows[0] || {});
    }
    catch (err) {
        console.error("❌ Error al obtener configuración de voz:", err);
        res.status(500).json({ error: "Error al obtener configuración." });
    }
});
// 📤 GUARDAR configuración de voz
router.post("/", auth_1.authenticateUser, upload.none(), async (req, res) => {
    const { tenant_id } = req.user;
    const { idioma, voice_name, system_prompt, welcome_message, voice_hints, canal = "voz", funciones_asistente, info_clave, audio_demo_url // opcional, si lo usas
     } = req.body;
    if (!idioma || !voice_name || !tenant_id) {
        return res.status(400).json({ error: "Faltan campos requeridos." });
    }
    if (!system_prompt?.trim() || !welcome_message?.trim()) {
        return res.status(400).json({ error: "Prompt o mensaje de bienvenida vacío." });
    }
    try {
        await db_1.default.query(`INSERT INTO voice_configs (
        tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints,
        canal, funciones_asistente, info_clave, audio_demo_url
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, idioma, canal)
      DO UPDATE SET 
        voice_name = EXCLUDED.voice_name,
        system_prompt = EXCLUDED.system_prompt,
        welcome_message = EXCLUDED.welcome_message,
        voice_hints = EXCLUDED.voice_hints,
        funciones_asistente = EXCLUDED.funciones_asistente,
        info_clave = EXCLUDED.info_clave,
        audio_demo_url = EXCLUDED.audio_demo_url,
        updated_at = NOW()`, [
            tenant_id,
            idioma,
            voice_name,
            system_prompt,
            welcome_message,
            voice_hints,
            canal,
            funciones_asistente,
            info_clave,
            audio_demo_url || null,
        ]);
        res.status(200).json({ ok: true, message: "Configuración de voz guardada correctamente." });
    }
    catch (err) {
        console.error("❌ Error al guardar voice config:", err);
        res.status(500).json({ error: "Error interno al guardar configuración." });
    }
});
exports.default = router;
