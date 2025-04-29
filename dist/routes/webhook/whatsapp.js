"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../../lib/db"));
const openai_1 = __importDefault(require("openai"));
const twilio_1 = __importDefault(require("twilio"));
const incrementUsage_1 = require("../../lib/incrementUsage");
const getPromptPorCanal_1 = require("../../lib/getPromptPorCanal");
const router = (0, express_1.Router)();
const MessagingResponse = twilio_1.default.twiml.MessagingResponse;
// 🧠 Normalizar texto
function normalizarTexto(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}
// 🧠 Buscar en Flows
function buscarRespuestaDesdeFlows(flows, mensajeUsuario) {
    const normalizado = normalizarTexto(mensajeUsuario);
    for (const flujo of flows) {
        for (const opcion of flujo.opciones || []) {
            if (normalizarTexto(opcion.texto || '') === normalizado) {
                return opcion.respuesta || opcion.submenu?.mensaje || null;
            }
            if (opcion.submenu) {
                for (const sub of opcion.submenu.opciones || []) {
                    if (normalizarTexto(sub.texto || '') === normalizado) {
                        return sub.respuesta || null;
                    }
                }
            }
        }
    }
    return null;
}
// 🔎 Detectar intención de compra
async function detectarIntencion(mensaje) {
    const openai = new openai_1.default({
        apiKey: process.env.OPENAI_API_KEY || '',
    });
    const prompt = `
Analiza este mensaje de un cliente:

"${mensaje}"

Identifica:
- Intención de compra (por ejemplo: pedir precios, reservar cita, ubicación, cancelar, etc.).
- Nivel de interés (de 1 a 5, siendo 5 "muy interesado en comprar").

Responde solo en JSON. Ejemplo:
{
  "intencion": "preguntar precios",
  "nivel_interes": 4
}
`;
    const respuesta = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
    });
    const content = respuesta.choices[0]?.message?.content || '{}';
    const data = JSON.parse(content);
    return {
        intencion: data.intencion || 'no_detectada',
        nivel_interes: data.nivel_interes || 1,
    };
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
        const saludo = `Soy Amy, bienvenido a ${tenant.name || 'nuestro negocio'}.`;
        const promptBase = `${saludo}\n${(0, getPromptPorCanal_1.getPromptPorCanal)('whatsapp', tenant)}`;
        const bienvenida = (0, getPromptPorCanal_1.getBienvenidaPorCanal)('whatsapp', tenant);
        // 📥 Leer Flows
        let flows = [];
        try {
            const flowsRes = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant.id]);
            const raw = flowsRes.rows[0]?.data;
            flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar los flujos:', e);
        }
        // 📥 Leer FAQs
        let faqs = [];
        try {
            const faqsRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant.id]);
            faqs = faqsRes.rows || [];
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar las FAQs:', e);
        }
        console.log("📝 Mensaje recibido:", userInput);
        const mensajeUsuario = normalizarTexto(userInput);
        let respuesta = null;
        const respuestaFAQ = faqs.find(faq => mensajeUsuario.includes(normalizarTexto(faq.pregunta)));
        if (respuestaFAQ) {
            respuesta = respuestaFAQ.respuesta;
        }
        else {
            respuesta = buscarRespuestaDesdeFlows(flows, userInput);
        }
        if (!respuesta) {
            console.log("🤖 Consultando a OpenAI...");
            const openai = new openai_1.default({
                apiKey: process.env.OPENAI_API_KEY || '',
            });
            const completion = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: promptBase },
                    { role: 'user', content: userInput },
                ],
            });
            respuesta = completion.choices[0]?.message?.content || bienvenida || 'Lo siento, no entendí eso.';
        }
        // 🧠 Inteligencia de ventas y seguimiento
        if (userInput) {
            try {
                const { intencion, nivel_interes } = await detectarIntencion(userInput);
                await db_1.default.query(`INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
           VALUES ($1, $2, $3, $4, $5, $6)`, [tenant.id, fromNumber, 'whatsapp', userInput, intencion, nivel_interes]);
                console.log("✅ Intención detectada y guardada:", intencion, nivel_interes);
                if (nivel_interes >= 4) {
                    const configRes = await db_1.default.query(`SELECT * FROM follow_up_settings WHERE tenant_id = $1`, [tenant.id]);
                    const config = configRes.rows[0];
                    if (config) {
                        let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
                        const intencionDetectada = intencion.toLowerCase();
                        if (intencionDetectada.includes('precio') && config.mensaje_precio) {
                            mensajeSeguimiento = config.mensaje_precio;
                        }
                        else if (intencionDetectada.includes('agendar') && config.mensaje_agendar) {
                            mensajeSeguimiento = config.mensaje_agendar;
                        }
                        else if (intencionDetectada.includes('ubicacion') && config.mensaje_ubicacion) {
                            mensajeSeguimiento = config.mensaje_ubicacion;
                        }
                        const fechaEnvio = new Date();
                        fechaEnvio.setMinutes(fechaEnvio.getMinutes() + (config.minutos_espera || 5));
                        await db_1.default.query(`INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
               VALUES ($1, $2, $3, $4, $5, false)`, [tenant.id, 'whatsapp', fromNumber, mensajeSeguimiento, fechaEnvio]);
                        console.log("📤 Mensaje de seguimiento programado:", mensajeSeguimiento);
                    }
                }
            }
            catch (err) {
                console.error("❌ Error analizando intención o programando seguimiento:", err);
            }
        }
        // 💾 Guardar mensaje del usuario
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'whatsapp', $3)`, [tenant.id, userInput, fromNumber]);
        // 💾 Guardar respuesta del bot
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'whatsapp')`, [tenant.id, respuesta]);
        // 💾 Guardar interacción
        await db_1.default.query(`INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'whatsapp', NOW())`, [tenant.id]);
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
