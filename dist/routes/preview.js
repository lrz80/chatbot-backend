"use strict";
// ✅ src/routes/preview.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../lib/db"));
const openai_1 = __importDefault(require("openai"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
// 🔍 Función para normalizar texto (quita tildes, minúsculas, espacios)
function normalizarTexto(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}
// 🔍 Función recursiva para buscar coincidencias en flujos anidados
function buscarRespuestaEnFlujos(flows, mensaje) {
    const normalizado = normalizarTexto(mensaje);
    for (const flow of flows) {
        for (const opcion of flow.opciones || []) {
            if (normalizarTexto(opcion.texto || '') === normalizado && opcion.respuesta) {
                return opcion.respuesta;
            }
            if (opcion.submenu) {
                const respuestaSub = buscarRespuestaEnFlujos([opcion.submenu], mensaje);
                if (respuestaSub)
                    return respuestaSub;
            }
        }
    }
    return null;
}
router.post('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        const { message } = req.body;
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant no autenticado' });
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        const nombreNegocio = tenant.name || 'nuestro negocio';
        const promptNegocio = tenant.prompt || 'Eres un asistente útil y profesional.';
        const saludoInicial = `Soy Amy, bienvenido a ${nombreNegocio}.`;
        const prompt = `${saludoInicial}\n${promptNegocio}`;
        const mensajeUsuario = normalizarTexto(message);
        // 📋 Buscar en FAQs primero
        let faqs = [];
        try {
            const faqsRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant_id]);
            faqs = faqsRes.rows || [];
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar FAQs:', e);
        }
        for (const faq of faqs) {
            console.log("🔎 Comparando mensaje:", mensajeUsuario, "con FAQ:", normalizarTexto(faq.pregunta));
            if (mensajeUsuario.includes(normalizarTexto(faq.pregunta))) {
                console.log("✅ Respuesta detectada desde FAQs");
                return res.status(200).json({ response: faq.respuesta });
            }
        }
        // 🧠 Buscar en Flows si no encontró en FAQs
        let flows = [];
        try {
            const flowsRes = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant_id]);
            const raw = flowsRes.rows[0]?.data;
            flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar Flows:', e);
        }
        const respuestaFlujo = buscarRespuestaEnFlujos(flows, message);
        if (respuestaFlujo) {
            console.log("✅ Respuesta detectada desde Flows");
            return res.status(200).json({ response: respuestaFlujo });
        }
        // 🤖 Si no hay nada en FAQs ni Flows, usar OpenAI
        console.log("🤖 Consultando a OpenAI...");
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: message },
            ],
        });
        const response = completion.choices[0]?.message?.content || 'Lo siento, no entendí eso.';
        console.log("🤖 Respuesta de OpenAI:", response);
        return res.status(200).json({ response });
    }
    catch (err) {
        console.error('❌ Error en preview:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
exports.default = router;
