"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const openai_1 = __importDefault(require("openai"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
const openai = new openai_1.default({
    apiKey: process.env.OPENAI_API_KEY,
});
router.post("/", async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: "Token requerido" });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const tenant_id = decoded.tenant_id;
        const { descripcion, informacion, idioma } = req.body;
        if (!descripcion || !informacion || !idioma) {
            return res.status(400).json({ error: "Faltan campos requeridos" });
        }
        // Verifica que el tenant exista
        const tenantRes = await db_1.default.query("SELECT * FROM tenants WHERE id = $1", [tenant_id]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.status(404).json({ error: "Negocio no encontrado" });
        // 🔮 Llamada a OpenAI para generar el prompt
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: `Actúa como un generador de instrucciones para asistentes virtuales.`,
                },
                {
                    role: "user",
                    content: `Estoy creando un asistente virtual en ${idioma}. Su función principal es: ${descripcion}.
          
Aquí está la información clave del negocio que el asistente debe conocer:
${informacion}

Crea un prompt de sistema claro, en ${idioma}, que pueda usarse directamente para configurar al asistente.`,
                },
            ],
        });
        const prompt = completion.choices[0]?.message?.content || null;
        if (!prompt) {
            return res.status(500).json({ error: "No se pudo generar el prompt" });
        }
        res.status(200).json({ prompt });
    }
    catch (err) {
        console.error("❌ Error generando prompt:", err);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});
exports.default = router;
