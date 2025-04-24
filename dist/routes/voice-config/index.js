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
// 🔄 GUARDAR configuración de voz
router.post("/", auth_1.authenticateUser, upload.none(), async (req, res) => {
    const { tenant_id } = req.user;
    const { idioma, voice_name, system_prompt, welcome_message, voice_hints, canal = "voz" } = req.body;
    if (!idioma || !voice_name || !tenant_id) {
        return res.status(400).json({ error: "Faltan campos requeridos." });
    }
    try {
        // Eliminar configuraciones anteriores por idioma y canal
        await db_1.default.query("DELETE FROM voice_configs WHERE tenant_id = $1 AND idioma = $2 AND canal = $3", [tenant_id, idioma, canal]);
        await db_1.default.query(`INSERT INTO voice_configs (
        tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints, canal
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints, canal]);
        res.status(200).json({ ok: true });
    }
    catch (err) {
        console.error("❌ Error al guardar voice config:", err);
        res.status(500).json({ error: "Error interno al guardar configuración." });
    }
});
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
exports.default = router;
