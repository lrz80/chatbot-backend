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
const db_1 = __importDefault(require("../lib/db"));
const auth_1 = require("../middleware/auth");
const getPromptPorCanal_1 = require("../lib/getPromptPorCanal");
const detectarIdioma_1 = require("../lib/detectarIdioma");
const traducirMensaje_1 = require("../lib/traducirMensaje");
const respuestasTraducidas_1 = require("../lib/respuestasTraducidas");
const router = (0, express_1.Router)();
function normalizarTexto(texto) {
    return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
router.post('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        const { message, canal = 'preview-meta' } = req.body;
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant no autenticado' });
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        const idioma = await (0, detectarIdioma_1.detectarIdioma)(message);
        const prompt = await (0, getPromptPorCanal_1.getPromptPorCanal)(canal, tenant, idioma);
        const bienvenida = await (0, getPromptPorCanal_1.getBienvenidaPorCanal)(canal, tenant, idioma);
        const mensajeUsuario = normalizarTexto(message);
        if (['hola', 'buenas', 'hello', 'hi', 'hey'].includes(mensajeUsuario)) {
            return res.status(200).json({ response: bienvenida });
        }
        let faqs = [];
        try {
            const faqsRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant_id]);
            faqs = faqsRes.rows || [];
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar FAQs:', e);
        }
        let flows = [];
        try {
            const flowsRes = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant_id]);
            const raw = flowsRes.rows[0]?.data;
            flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!Array.isArray(flows))
                flows = [];
        }
        catch (e) {
            flows = [];
            console.warn('⚠️ No se pudieron cargar Flows:', e);
        }
        let respuesta = await (0, respuestasTraducidas_1.buscarRespuestaSimilitudFaqsTraducido)(faqs, message, idioma)
            ?? await (0, respuestasTraducidas_1.buscarRespuestaDesdeFlowsTraducido)(flows, message, idioma);
        if (!respuesta) {
            const { default: OpenAI } = await Promise.resolve().then(() => __importStar(require('openai')));
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
            // 📝 Personalización con el nombre del negocio (tenant.name)
            const contacto = tenant.email || 'nuestro equipo';
            let promptFinal = prompt.trim() !== ''
                ? prompt
                : `Eres un asistente virtual de ${tenant.name}. Si el cliente pregunta por precios u otros detalles y no tienes información, indícale amablemente que contacte directamente a ${contacto}. No inventes datos.`;
            const completion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: 'system', content: promptFinal },
                    { role: 'user', content: message },
                ],
            });
            respuesta = completion.choices[0]?.message?.content?.trim() ?? bienvenida ?? 'Lo siento, no entendí eso.';
        }
        const idiomaFinal = await (0, detectarIdioma_1.detectarIdioma)(respuesta);
        if (idiomaFinal !== idioma) {
            respuesta = await (0, traducirMensaje_1.traducirMensaje)(respuesta, idioma);
        }
        res.status(200).json({ response: respuesta });
    }
    catch (err) {
        console.error('❌ Error en preview:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
