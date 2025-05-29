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
// ✅ src/routes/webhook/voice-response.ts
const express_1 = require("express");
const twilio_1 = require("twilio");
const axios_1 = __importDefault(require("axios"));
const db_1 = __importDefault(require("../../lib/db"));
const uploadAudioToCDN_1 = require("../../utils/uploadAudioToCDN");
const incrementUsage_1 = require("../../lib/incrementUsage");
const twilio_2 = __importDefault(require("twilio"));
const router = (0, express_1.Router)();
function normalizarTexto(texto) {
    return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function obtenerSaludoHora() {
    const hora = new Date().getHours();
    if (hora < 12)
        return 'Buenos días';
    if (hora < 18)
        return 'Buenas tardes';
    return 'Buenas noches';
}
router.post('/', async (req, res) => {
    const to = req.body.To || '';
    const from = req.body.From || '';
    const numero = to.replace('tel:', '');
    const fromNumber = from.replace('tel:', '');
    const userInput = req.body.SpeechResult;
    try {
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_voice_number = $1', [numero]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.sendStatus(404);
        const configRes = await db_1.default.query('SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 LIMIT 1', [tenant.id, 'voz']);
        const config = configRes.rows[0];
        if (!config)
            return res.sendStatus(404);
        const idioma = config.idioma || 'es-ES';
        const voiceId = config.voice_name || 'EXAVITQu4vr4xnSDxMaL';
        const nombreNegocio = tenant.name || 'nuestro negocio';
        const saludoHora = obtenerSaludoHora();
        const saludoInicial = `${saludoHora}, mi nombre es Amy, asistente de ${nombreNegocio}.`;
        const response = new twilio_1.twiml.VoiceResponse();
        // Si es la primera vez (no hay SpeechResult)
        if (!userInput) {
            response.say({ voice: 'Polly.Conchita', language: idioma }, saludoInicial);
            response.gather({
                input: ['speech'],
                action: '/webhook/voice-response',
                method: 'POST',
                language: idioma,
                speechTimeout: 'auto',
            });
            return res.type('text/xml').send(response.toString());
        }
        // Prompt del asistente (sin incluir saludo)
        const prompt = config.system_prompt || `
Eres Amy, una asistente telefónica de voz cálida, clara y natural. Responde en frases cortas y con una actitud amigable. Nunca digas que eres un asistente virtual, responde como si fueras parte real del equipo de ${nombreNegocio}. Si el cliente da las gracias o quiere terminar, despídete cordialmente.
    `.trim();
        const { default: OpenAI } = await Promise.resolve().then(() => __importStar(require('openai')));
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: userInput },
            ],
        });
        const respuesta = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';
        const tokensConsumidos = completion.usage?.total_tokens || 0;
        if (tokensConsumidos > 0) {
            await db_1.default.query(`UPDATE uso_mensual
        SET usados = usados + $1
        WHERE tenant_id = $2 AND canal = 'voz' AND mes = date_trunc('month', CURRENT_DATE)`, [tokensConsumidos, tenant.id]);
        }
        // Añadir pausas naturales con SSML
        const textoConPausas = respuesta
            .replace(/\.\s*/g, '. <break time="400ms"/> ')
            .replace(/,\s*/g, ', <break time="300ms"/> ');
        // Generar audio con ElevenLabs usando SSML
        const ssmlTexto = `<speak>${textoConPausas}</speak>`;
        const audioRes = await axios_1.default.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?model_id=eleven_monolingual_v1`, // ✅ model_id aquí
        ssmlTexto, {
            headers: {
                "xi-api-key": process.env.ELEVENLABS_API_KEY,
                "Content-Type": "application/ssml+xml",
                Accept: "audio/mpeg",
            },
            responseType: "arraybuffer",
        });
        const audioBuffer = Buffer.from(audioRes.data);
        const audioUrl = await (0, uploadAudioToCDN_1.guardarAudioEnCDN)(audioBuffer, tenant.id);
        // Guardar mensajes e interacción
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)`, [tenant.id, userInput, fromNumber]);
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'voice')`, [tenant.id, respuesta]);
        await db_1.default.query(`INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voice', NOW())`, [tenant.id]);
        await (0, incrementUsage_1.incrementarUsoPorNumero)(numero);
        // Intento de detectar intención y enviar link útil
        try {
            const intencionPrompt = `
El cliente dijo: "${userInput}"
¿Qué intención tiene? Responde solo con una palabra: reservar, comprar, soporte, web, otro.
      `;
            const intencionRes = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [{ role: 'system', content: intencionPrompt }],
            });
            const intencion = intencionRes.choices[0].message?.content?.toLowerCase().trim() || '';
            if (['reservar', 'comprar', 'soporte', 'web'].includes(intencion)) {
                const linkRes = await db_1.default.query(`SELECT url, nombre FROM links_utiles
           WHERE tenant_id = $1 AND tipo = $2
           ORDER BY created_at DESC LIMIT 1`, [tenant.id, intencion]);
                const link = linkRes.rows[0]?.url;
                const nombreLink = linkRes.rows[0]?.nombre;
                if (link) {
                    const client = (0, twilio_2.default)(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
                    await client.messages.create({
                        from: numero,
                        to: fromNumber,
                        body: `📎 ${nombreLink}: ${link}`,
                    });
                    console.log(`✅ SMS enviado con link de ${intencion}`);
                }
            }
        }
        catch (e) {
            console.warn('⚠️ No se pudo detectar intención ni enviar link útil:', e);
        }
        // Verificar si la conversación debe terminar
        const finConversacion = /(gracias|eso es todo|nada más|bye|adiós)/i.test(userInput);
        response.play(audioUrl);
        if (!finConversacion) {
            response.gather({
                input: ['speech'],
                action: '/webhook/voice-response',
                method: 'POST',
                language: idioma,
                speechTimeout: 'auto',
            });
        }
        else {
            response.say({ voice: 'Polly.Conchita', language: idioma }, 'Gracias por tu llamada. ¡Hasta luego!');
            response.hangup();
        }
        res.type('text/xml').send(response.toString());
    }
    catch (err) {
        console.error('❌ Error en voice-response:', err);
        res.sendStatus(500);
    }
});
exports.default = router;
