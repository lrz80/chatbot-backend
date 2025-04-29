"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
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
        // 🧠 Importar OpenAI dinámicamente
        const { default: OpenAI } = await Promise.resolve().then(() => __importStar(require("openai")));
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
        // 🔮 Generar prompt desde OpenAI
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

Información que el asistente debe conocer:
${informacion}

Redacta únicamente un texto claro y profesional (no JSON) que describa cómo debe comportarse el asistente. 
No incluyas ningún mensaje de bienvenida ni estructura técnica. 
Solo devuelve el texto plano que servirá como prompt de sistema.`,
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
