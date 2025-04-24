"use strict";
// src/routes/voice-prompt/index.ts
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
    const { idioma, categoria } = req.body;
    const tenant_id = req.user?.tenant_id;
    if (!idioma || !categoria) {
        return res.status(400).json({ error: "Faltan idioma o categoría." });
    }
    if (!tenant_id) {
        return res.status(401).json({ error: "Tenant no autenticado." });
    }
    try {
        const { prompt, bienvenida } = await (0, voicePromptTemplate_1.PromptTemplate)({ idioma, categoria, tenant_id });
        const voice_name = "alice";
        // Guardar en la tabla voice_configs
        await db_1.default.query(`INSERT INTO voice_configs (tenant_id, idioma, categoria, system_prompt, welcome_message, canal, voice_name)
       VALUES ($1, $2, $3, $4, $5, 'voz', $6)
       ON CONFLICT (tenant_id) DO UPDATE 
       SET idioma = $2, categoria = $3, system_prompt = $4, welcome_message = $5, voice_name = $6, updated_at = NOW()`, [tenant_id, idioma, categoria, prompt, bienvenida, voice_name]);
        res.json({ prompt, bienvenida });
    }
    catch (err) {
        console.error("❌ Error generando o guardando el prompt de voz:", err);
        res.status(500).json({ error: "Error generando el prompt." });
    }
});
exports.default = router;
