"use strict";
// ✅ src/routes/voice-prompt/index.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../../middleware/auth");
const voicePromptTemplate_1 = require("../../utils/voicePromptTemplate");
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
router.post("/", auth_1.authenticateUser, async (req, res) => {
    const { idioma, categoria, funciones_asistente, info_clave } = req.body;
    const tenant_id = req.user?.tenant_id;
    const canal = "voz";
    const voice_name = "alice";
    if (!idioma || !categoria) {
        return res.status(400).json({ error: "Faltan idioma o categoría." });
    }
    if (!tenant_id) {
        return res.status(401).json({ error: "Tenant no autenticado." });
    }
    if (!funciones_asistente?.trim() || !info_clave?.trim()) {
        return res.status(400).json({ error: "Debes completar funciones e info clave." });
    }
    try {
        const { rows } = await db_1.default.query(`SELECT membresia_activa FROM tenants WHERE id = $1`, [tenant_id]);
        if (!rows[0]?.membresia_activa) {
            return res.status(403).json({ error: "Tu membresía está inactiva. Actívala para continuar." });
        }
        // 🧠 Generar prompt usando funciones e info clave
        const { prompt, bienvenida } = await (0, voicePromptTemplate_1.PromptTemplate)({
            idioma,
            categoria,
            tenant_id,
            funciones_asistente,
            info_clave,
        });
        await db_1.default.query(`INSERT INTO voice_configs (
        tenant_id, idioma, categoria, system_prompt, welcome_message, canal, voice_name, funciones_asistente, info_clave
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, canal) DO UPDATE SET
        idioma = EXCLUDED.idioma,
        categoria = EXCLUDED.categoria,
        system_prompt = EXCLUDED.system_prompt,
        welcome_message = EXCLUDED.welcome_message,
        voice_name = EXCLUDED.voice_name,
        funciones_asistente = EXCLUDED.funciones_asistente,
        info_clave = EXCLUDED.info_clave,
        updated_at = NOW()`, [
            tenant_id,
            idioma,
            categoria,
            prompt,
            bienvenida,
            canal,
            voice_name,
            funciones_asistente,
            info_clave,
        ]);
        res.json({ prompt, bienvenida });
    }
    catch (err) {
        console.error("❌ Error generando o guardando el prompt de voz:", err);
        res.status(500).json({ error: "Error generando el prompt." });
    }
});
exports.default = router;
