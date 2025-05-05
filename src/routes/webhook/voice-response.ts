// ✅ src/routes/webhook/voice-response.ts
import { Router } from 'express';
import { twiml } from 'twilio';
import axios from 'axios';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { guardarAudioEnCDN } from '../../utils/uploadAudioToCDN';

const router = Router();

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function obtenerSaludoHora(): string {
  const hora = new Date().getHours();
  if (hora < 12) return 'Buenos días';
  if (hora < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

router.post('/', async (req, res) => {
  const to = req.body.To || '';
  const from = req.body.From || '';
  const numero = to.replace('tel:', '');
  const fromNumber = from.replace('tel:', '');
  const userInput = req.body.SpeechResult;

  try {
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE twilio_voice_number = $1', [numero]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    const configRes = await pool.query(
      'SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 LIMIT 1',
      [tenant.id, 'voz']
    );
    const config = configRes.rows[0];
    if (!config) return res.sendStatus(404);

    const saludoHora = obtenerSaludoHora();
    const nombreNegocio = tenant.name || 'nuestro negocio';
    const saludoInicial = `${saludoHora}, mi nombre es Amy, asistente de ${nombreNegocio}.`;

    const response = new twiml.VoiceResponse();

    // 🟣 Si no hay SpeechResult, solo saludo y gather
    if (!userInput) {
      response.say({ voice: 'Polly.Conchita', language: config.idioma || 'es-ES' }, saludoInicial);
      response.gather({
        input: ['speech'],
        action: '/webhook/voice-response',
        method: 'POST',
        language: config.idioma || 'es-ES',
        speechTimeout: 'auto',
      });

      return res.type('text/xml').send(response.toString());
    }

    // 🟢 Aquí ya hay SpeechResult — procesamiento completo
    const mensajesPreviosRes = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE tenant_id = $1 AND from_number = $2 AND canal = 'voice'`,
      [tenant.id, fromNumber]
    );
    const esPrimeraVez = parseInt(mensajesPreviosRes.rows[0].count, 10) === 0;

    const prompt = esPrimeraVez
      ? `${saludoInicial}\n${config.system_prompt || 'Eres un asistente telefónico amigable y profesional.'}`
      : config.system_prompt || 'Eres un asistente telefónico amigable y profesional.';

    const voiceId = config.voice_name || 'EXAVITQu4vr4xnSDxMaL';
    const mensajeUsuario = normalizarTexto(userInput);

    let respuesta = null;
    let respuestaFAQ = null;

    try {
      const faqsRes = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant.id]);
      const faqs = faqsRes.rows || [];
      for (const faq of faqs) {
        if (mensajeUsuario.includes(normalizarTexto(faq.pregunta))) {
          respuestaFAQ = faq.respuesta;
          break;
        }
      }
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar FAQs:', e);
    }

    if (respuestaFAQ) {
      respuesta = respuestaFAQ;
    } else {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userInput },
        ],
      });

      respuesta = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';
    }

    const textoFinal = esPrimeraVez ? `${saludoInicial}. ${respuesta}` : respuesta;

    const audioRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: textoFinal,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
        },
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY!,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
      }
    );

    const audioBuffer = Buffer.from(audioRes.data);
    const audioUrl = await guardarAudioEnCDN(audioBuffer, tenant.id);

    const contactoRes = await pool.query(
      `SELECT nombre, segmento FROM contactos WHERE tenant_id = $1 AND telefono = $2 LIMIT 1`,
      [tenant.id, fromNumber]
    );

    const contacto = contactoRes.rows[0];
    const nombreFinal = contacto?.nombre || req.body.CallerName || null;
    const segmentoInicial = contacto?.segmento || 'lead';

    await pool.query(
      `INSERT INTO clientes (tenant_id, canal, contacto, creado, nombre, segmento)
      VALUES ($1, 'voz', $2, NOW(), $3, $4)
      ON CONFLICT (contacto) DO UPDATE SET
        nombre = COALESCE(EXCLUDED.nombre, clientes.nombre),
        segmento = CASE
          WHEN clientes.segmento = 'lead' AND EXCLUDED.segmento = 'cliente' THEN 'cliente'
          ELSE clientes.segmento
        END`,
      [tenant.id, fromNumber, nombreFinal, segmentoInicial]
    );

    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

      const intencionPrompt = `
    Analiza este mensaje de un cliente por llamada:

    "${userInput}"

    Identifica:
    - Intención de compra (por ejemplo: pedir precios, reservar cita, ubicación, cancelar, etc.).

    Responde solo con la intención, como "comprar", "reservar", "cancelar", etc.
    `;

      const intencionRes = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'system', content: intencionPrompt }],
      });

      const intencion = intencionRes.choices[0].message?.content?.toLowerCase().trim() || '';

      if (
        ['comprar', 'compra', 'pagar', 'agendar', 'reservar', 'confirmar'].some(p =>
          intencion.includes(p)
        )
      ) {
        await pool.query(
          `UPDATE clientes
          SET segmento = 'cliente'
          WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`,
          [tenant.id, fromNumber]
        );
      }
    } catch (e) {
      console.warn("⚠️ No se pudo detectar intención de voz:", e);
    }

    let emocion = 'neutral';
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

      const emotionPrompt = `
Actúa como un analista emocional. Clasifica la emoción dominante en este mensaje del cliente:
"${userInput}"

Elige solo una palabra: enfado, tristeza, neutral, satisfacción o entusiasmo.
      `;

      const emotionRes = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'system', content: emotionPrompt }],
      });

      emocion = emotionRes.choices[0].message?.content?.trim().toLowerCase() || 'neutral';
    } catch (e) {
      console.warn('⚠️ No se pudo analizar emoción:', e);
    }

    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)`,
      [tenant.id, userInput, fromNumber]
    );

    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'voice')`,
      [tenant.id, respuesta]
    );

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voice', NOW())`,
      [tenant.id]
    );

    await incrementarUsoPorNumero(numero);

    const finConversacion = /(gracias|eso es todo|nada más|bye|adiós)/i.test(userInput);

    response.play(audioUrl);

    if (!finConversacion) {
      response.gather({
        input: ['speech'],
        action: '/webhook/voice-response',
        method: 'POST',
        language: config.idioma || 'es-ES',
        speechTimeout: 'auto',
      });
    } else {
      response.say(
        { voice: 'Polly.Conchita', language: config.idioma || 'es-ES' },
        'Gracias por tu llamada. ¡Hasta luego!'
      );
      response.hangup();
    }

    res.type('text/xml');
    res.send(response.toString());
  } catch (err) {
    console.error('❌ Error en voice-response:', err);
    res.sendStatus(500);
  }
});

export default router;
