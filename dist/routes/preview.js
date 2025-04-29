"use strict";
// ✅ src/routes/preview.ts
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
const db_1 = __importDefault(require("../lib/db"));
const auth_1 = require("../middleware/auth");
const getPromptPorCanal_1 = require("../lib/getPromptPorCanal");
const buscarRespuestaDesdeFlows_1 = require("../lib/buscarRespuestaDesdeFlows");
const router = (0, express_1.Router)();
// 🔍 Función para normalizar texto (quita tildes, minúsculas, espacios)
function normalizarTexto(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}
router.post('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        const { message } = req.body;
        const canal = 'preview';
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant no autenticado' });
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        const prompt = (0, getPromptPorCanal_1.getPromptPorCanal)(canal, tenant);
        const bienvenida = (0, getPromptPorCanal_1.getBienvenidaPorCanal)(canal, tenant);
        const mensajeUsuario = normalizarTexto(message);
        // 📋 Cargar FAQs
        let faqs = [];
        try {
            const faqsRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant_id]);
            faqs = faqsRes.rows || [];
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar FAQs:', e);
        }
        for (const faq of faqs) {
            if (mensajeUsuario.includes(normalizarTexto(faq.pregunta))) {
                return res.status(200).json({ response: faq.respuesta });
            }
        }
        // 📋 Cargar Flows
        let flows = [];
        try {
            const flowsRes = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant_id]);
            const raw = flowsRes.rows[0]?.data;
            flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar Flows:', e);
        }
        const respuestaFlujo = (0, buscarRespuestaDesdeFlows_1.buscarRespuestaDesdeFlows)(flows, message);
        if (respuestaFlujo) {
            return res.status(200).json({ response: respuestaFlujo });
        }
        // 🧠 OpenAI fallback solo si no encontró en FAQs ni Flows
        const { default: OpenAI } = await Promise.resolve().then(() => __importStar(require('openai')));
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: message },
            ],
        });
        const respuestaIA = completion.choices[0]?.message?.content?.trim() || bienvenida || 'Lo siento, no entendí eso.';
        return res.status(200).json({ response: respuestaIA });
    }
    catch (err) {
        console.error('❌ Error en preview:', err);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
