"use strict";
// backend/src/routes/webhook/whatsapp.ts
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
const detectarIdioma_1 = require("../../lib/detectarIdioma");
const traducirMensaje_1 = require("../../lib/traducirMensaje");
const respuestasTraducidas_1 = require("../../lib/respuestasTraducidas");
const whatsapp_1 = require("../../lib/senders/whatsapp");
const router = (0, express_1.Router)();
const MessagingResponse = twilio_1.default.twiml.MessagingResponse;
function normalizarTexto(texto) {
    return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
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
async function detectarIntencion(mensaje) {
    const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY || '' });
    const prompt = `Analiza este mensaje de un cliente:\n\n"${mensaje}"\n\nIdentifica:\n- Intención de compra (por ejemplo: pedir precios, reservar cita, ubicación, cancelar, etc.).\n- Nivel de interés (de 1 a 5, siendo 5 \"muy interesado en comprar\").\n\nResponde solo en JSON. Ejemplo:\n{\n  "intencion": "preguntar precios",\n  "nivel_interes": 4\n}`;
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
function buscarRespuestaSimilitudFaqs(faqs, mensaje) {
    const msg = normalizarTexto(mensaje);
    for (const faq of faqs) {
        const pregunta = normalizarTexto(faq.pregunta || '');
        const palabras = pregunta.split(' ').filter(Boolean);
        const coincidencias = palabras.filter(p => msg.includes(p));
        if (coincidencias.length >= 3)
            return faq.respuesta;
    }
    return null;
}
router.post('/', async (req, res) => {
    console.log("📩 Webhook recibido:", req.body);
    // 🟢 Responder de inmediato a Twilio
    const twiml = new MessagingResponse();
    res.type('text/xml').send(new MessagingResponse().toString());
    console.log("📤 Respuesta rápida enviada a Twilio");
    // 🧠 Procesar el resto en segundo plano
    setTimeout(async () => {
        try {
            await procesarMensajeWhatsApp(req.body);
        }
        catch (error) {
            console.error("❌ Error procesando mensaje en segundo plano:", error);
        }
    }, 0);
});
exports.default = router;
async function procesarMensajeWhatsApp(body) {
    const to = body.To || '';
    const from = body.From || '';
    const numero = to.replace('whatsapp:', '').replace('tel:', '');
    const fromNumber = from.replace('whatsapp:', '').replace('tel:', '');
    const userInput = body.Body || '';
    const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_number = $1 LIMIT 1', [numero]);
    const tenant = tenantRes.rows[0];
    if (!tenant)
        return;
    const idioma = await (0, detectarIdioma_1.detectarIdioma)(userInput);
    const promptBase = (0, getPromptPorCanal_1.getPromptPorCanal)('whatsapp', tenant, idioma);
    let respuesta = (0, getPromptPorCanal_1.getBienvenidaPorCanal)('whatsapp', tenant, idioma);
    const canal = 'whatsapp';
    let flows = [];
    try {
        const flowsRes = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant.id]);
        const raw = flowsRes.rows[0]?.data;
        flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    catch { }
    let faqs = [];
    try {
        const faqsRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant.id]);
        faqs = faqsRes.rows || [];
    }
    catch { }
    const mensajeUsuario = normalizarTexto(userInput);
    if (["hola", "buenas", "hello", "hi", "hey"].includes(mensajeUsuario)) {
        respuesta = (0, getPromptPorCanal_1.getBienvenidaPorCanal)('whatsapp', tenant, idioma);
    }
    else {
        respuesta = await (0, respuestasTraducidas_1.buscarRespuestaSimilitudFaqsTraducido)(faqs, mensajeUsuario, idioma)
            || await (0, respuestasTraducidas_1.buscarRespuestaDesdeFlowsTraducido)(flows, mensajeUsuario, idioma);
    }
    if (!respuesta) {
        const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY || '' });
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: 'system', content: promptBase },
                { role: 'user', content: userInput },
            ],
        });
        respuesta = completion.choices[0]?.message?.content?.trim() || (0, getPromptPorCanal_1.getBienvenidaPorCanal)('whatsapp', tenant, idioma);
        const tokensConsumidos = completion.usage?.total_tokens || 0;
        console.log(`🔎 Tokens generados: ${tokensConsumidos}`);
        if (tokensConsumidos > 0) {
            await db_1.default.query(`UPDATE uso_mensual
        SET usados = usados + $1
        WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`, [tokensConsumidos, tenant.id]);
        }
    }
    if (respuesta) {
        const idiomaRespuesta = await (0, detectarIdioma_1.detectarIdioma)(respuesta);
        if (idiomaRespuesta !== idioma) {
            respuesta = await (0, traducirMensaje_1.traducirMensaje)(respuesta, idioma);
        }
    }
    try {
        const { intencion, nivel_interes } = await detectarIntencion(userInput);
        const intencionLower = intencion.toLowerCase();
        if (["comprar", "compra", "pagar", "agendar", "reservar", "confirmar"].some(p => intencionLower.includes(p))) {
            await db_1.default.query(`UPDATE clientes SET segmento = 'cliente' WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`, [tenant.id, fromNumber]);
        }
        await db_1.default.query(`INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
       VALUES ($1, $2, $3, $4, $5, $6)`, [tenant.id, fromNumber, canal, userInput, intencion, nivel_interes]);
        if (nivel_interes >= 4) {
            const configRes = await db_1.default.query(`SELECT * FROM follow_up_settings WHERE tenant_id = $1`, [tenant.id]);
            const config = configRes.rows[0];
            if (config) {
                let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
                if (intencionLower.includes("precio") && config.mensaje_precio) {
                    mensajeSeguimiento = config.mensaje_precio;
                }
                else if ((intencionLower.includes("agendar") || intencionLower.includes("reservar")) && config.mensaje_agendar) {
                    mensajeSeguimiento = config.mensaje_agendar;
                }
                else if ((intencionLower.includes("ubicacion") || intencionLower.includes("location")) && config.mensaje_ubicacion) {
                    mensajeSeguimiento = config.mensaje_ubicacion;
                }
                try {
                    const idiomaMensaje = await (0, detectarIdioma_1.detectarIdioma)(mensajeSeguimiento);
                    if (idiomaMensaje !== idioma) {
                        mensajeSeguimiento = await (0, traducirMensaje_1.traducirMensaje)(mensajeSeguimiento, idioma);
                    }
                }
                catch { }
                const fechaEnvio = new Date();
                fechaEnvio.setMinutes(fechaEnvio.getMinutes() + (config.minutos_espera || 5));
                await db_1.default.query(`DELETE FROM mensajes_programados
           WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`, [tenant.id, canal, fromNumber]);
                await db_1.default.query(`INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
           VALUES ($1, $2, $3, $4, $5, false)`, [tenant.id, canal, fromNumber, mensajeSeguimiento, fechaEnvio]);
            }
        }
    }
    catch (err) {
        console.error("⚠️ Error en inteligencia de ventas:", err);
    }
    const contactoRes = await db_1.default.query(`SELECT nombre, segmento FROM contactos WHERE tenant_id = $1 AND telefono = $2 LIMIT 1`, [tenant.id, fromNumber]);
    const contactoPrevio = contactoRes.rows[0];
    const nombreDetectado = contactoPrevio?.nombre || body.ProfileName || null;
    const segmentoDetectado = contactoPrevio?.segmento || 'lead';
    await db_1.default.query(`INSERT INTO clientes (tenant_id, canal, contacto, creado, nombre, segmento)
     VALUES ($1, $2, $3, NOW(), $4, $5)
     ON CONFLICT (contacto) DO UPDATE SET
       nombre = COALESCE(EXCLUDED.nombre, clientes.nombre),
       segmento = CASE
         WHEN clientes.segmento = 'lead' AND EXCLUDED.segmento = 'cliente' THEN 'cliente'
         ELSE clientes.segmento
       END`, [tenant.id, canal, fromNumber, nombreDetectado, segmentoDetectado]);
    await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
     VALUES ($1, 'user', $2, NOW(), $3, $4)`, [tenant.id, userInput, canal, fromNumber]);
    await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
     VALUES ($1, 'bot', $2, NOW(), $3)`, [tenant.id, respuesta, canal]);
    // 📤 Enviar respuesta real por WhatsApp (post-procesamiento)
    await (0, whatsapp_1.enviarWhatsApp)(fromNumber, respuesta, tenant.id);
    console.log("📬 Respuesta enviada manualmente vía Twilio:", respuesta);
    await db_1.default.query(`INSERT INTO interactions (tenant_id, canal, created_at)
     VALUES ($1, $2, NOW())`, [tenant.id, canal]);
    await (0, incrementUsage_1.incrementarUsoPorNumero)(numero);
}
