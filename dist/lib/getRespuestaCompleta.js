"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRespuestaCompleta = getRespuestaCompleta;
const db_1 = __importDefault(require("./db"));
const getPromptPorCanal_1 = require("./getPromptPorCanal");
const normalizarTexto_1 = require("./normalizarTexto");
const traducirTexto_1 = require("./traducirTexto");
const openai_1 = __importDefault(require("openai"));
function preservarLinks(texto) {
    const links = [];
    const textoSinLinks = texto.replace(/https?:\/\/\S+/g, (match) => {
        links.push(match);
        return `{{LINK_${links.length - 1}}}`;
    });
    return { textoSinLinks, links };
}
function restaurarLinks(texto, links) {
    return texto.replace(/{{LINK_(\d+)}}/g, (_, index) => links[Number(index)] || '');
}
async function getRespuestaCompleta({ canal, tenant, input, idioma = 'es', }) {
    const mensajeDefault = idioma === 'en'
        ? 'Sorry, I don’t have an answer for that at the moment.'
        : 'Lo siento, no tengo una respuesta para eso en este momento.';
    let prompt = (0, getPromptPorCanal_1.getPromptPorCanal)(canal, tenant);
    const bienvenida = (0, getPromptPorCanal_1.getBienvenidaPorCanal)(canal, tenant);
    const mensaje = (0, normalizarTexto_1.normalizarTexto)(input);
    // 🌐 Traducir el prompt si el idioma no es español
    if (idioma !== 'es') {
        try {
            const { textoSinLinks, links } = preservarLinks(prompt);
            const textoTraducido = await (0, traducirTexto_1.traducirTexto)(textoSinLinks, idioma);
            prompt = restaurarLinks(textoTraducido, links);
        }
        catch (err) {
            console.warn('⚠️ No se pudo traducir el prompt:', err);
        }
    }
    // 1. FAQs
    const faqsRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant.id]);
    const faqs = faqsRes.rows || [];
    for (const faq of faqs) {
        if (mensaje.includes((0, normalizarTexto_1.normalizarTexto)(faq.pregunta)))
            return faq.respuesta;
    }
    // 2. Intents
    const intentsRes = await db_1.default.query('SELECT * FROM intents WHERE tenant_id = $1', [tenant.id]);
    const intents = intentsRes.rows || [];
    for (const intent of intents) {
        if ((intent.ejemplos || []).some((ej) => mensaje.includes((0, normalizarTexto_1.normalizarTexto)(ej)))) {
            return intent.respuesta;
        }
    }
    // 3. Fallback con OpenAI
    if (prompt) {
        const openai = new openai_1.default({
            apiKey: process.env.OPENAI_API_KEY || '',
        });
        const respuestaIA = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: input },
            ],
            max_tokens: 300,
        });
        return respuestaIA.choices[0]?.message.content?.trim() || bienvenida || mensajeDefault;
    }
    return bienvenida || mensajeDefault;
}
