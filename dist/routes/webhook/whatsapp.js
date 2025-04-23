"use strict";
// ✅ src/routes/webhook/whatsapp.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../../lib/db"));
const openai_1 = __importDefault(require("openai"));
const twilio_1 = __importDefault(require("twilio"));
const incrementUsage_1 = require("../../lib/incrementUsage");
const router = (0, express_1.Router)();
const MessagingResponse = twilio_1.default.twiml.MessagingResponse;
const openai = new openai_1.default({
    apiKey: process.env.OPENAI_API_KEY,
});
// 🧠 Función para buscar coincidencias en flujos y submenús
function buscarRespuestaDesdeFlows(flows, mensajeUsuario) {
    const normalizado = mensajeUsuario.trim().toLowerCase();
    for (const flujo of flows) {
        for (const opcion of flujo.opciones || []) {
            if (opcion.texto?.trim().toLowerCase() === normalizado) {
                if (opcion.respuesta)
                    return opcion.respuesta;
                if (opcion.submenu)
                    return opcion.submenu.mensaje;
            }
            if (opcion.submenu) {
                for (const sub of opcion.submenu.opciones || []) {
                    if (sub.texto?.trim().toLowerCase() === normalizado) {
                        return sub.respuesta || null;
                    }
                }
            }
        }
    }
    return null;
}
router.post('/', async (req, res) => {
    console.log("📩 Webhook recibido:", req.body);
    const to = req.body.To || '';
    const from = req.body.From || '';
    const numero = to.replace('whatsapp:', '').replace('tel:', '');
    const fromNumber = from.replace('whatsapp:', '').replace('tel:', '');
    const userInput = req.body.Body || '';
    try {
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_number = $1', [numero]);
        const tenant = tenantRes.rows[0];
        if (!tenant) {
            console.warn('🔴 Negocio no encontrado para número:', numero);
            return res.sendStatus(404);
        }
        const nombreNegocio = tenant.name || 'nuestro negocio';
        const promptBase = tenant.prompt || 'Eres un asistente útil para clientes en WhatsApp.';
        const saludo = `Soy Amy, bienvenido a ${nombreNegocio}.`;
        const prompt = `${saludo}\n${promptBase}`;
        // 📥 Leer flujos si existen
        let flows = [];
        try {
            const flowsRes = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant.id]);
            const raw = flowsRes.rows[0]?.data;
            flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar los flujos:', e);
        }
        // ✅ Intentar responder con flujos
        let respuesta = buscarRespuestaDesdeFlows(flows, userInput);
        // 🤖 Fallback con OpenAI si no hay coincidencia
        if (!respuesta) {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: userInput },
                ],
            });
            respuesta = completion.choices[0]?.message?.content || 'Lo siento, no entendí eso.';
        }
        // 💾 Guardar mensaje del usuario
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'whatsapp', $3)`, [tenant.id, userInput, fromNumber]);
        // 💾 Guardar interacción
        await db_1.default.query(`INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, $2, NOW())`, [tenant.id, 'whatsapp']);
        // 💾 Guardar respuesta del bot
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'whatsapp')`, [tenant.id, respuesta]);
        // 🔢 Incrementar contador
        await (0, incrementUsage_1.incrementarUsoPorNumero)(numero);
        // 📤 Enviar respuesta a WhatsApp
        const twiml = new MessagingResponse();
        twiml.message(respuesta);
        res.type('text/xml');
        res.send(twiml.toString());
    }
    catch (error) {
        console.error('❌ Error en webhook WhatsApp:', error);
        res.sendStatus(500);
    }
});
exports.default = router;
