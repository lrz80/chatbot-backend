// src/routes/webhook/voice-response.ts

import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';

const router = Router();

// 🔍 Función para normalizar texto (sin tildes, minúsculas)
function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

router.post('/', async (req, res) => {
  const to = req.body.To || '';
  const from = req.body.From || '';
  const numero = to.replace('tel:', '');
  const fromNumber = from.replace('tel:', '');
  const userInput = req.body.SpeechResult || 'No se recibió mensaje.';

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    const configRes = await pool.query(
      'SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 LIMIT 1',
      [tenant.id, 'voz']
    );
    const config = configRes.rows[0];
    if (!config) return res.sendStatus(404);

    const prompt = config.system_prompt || 'Eres un asistente telefónico amigable y profesional.';
    const voiceLang = config.idioma || 'es-ES';
    const voiceName = config.voice_name || 'alice';

    const mensajeUsuario = normalizarTexto(userInput);

    // 📚 Leer FAQs
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

    let respuesta = null;

    if (respuestaFAQ) {
      respuesta = respuestaFAQ;
    } else {
      // 🔑 Instanciar OpenAI solo si es necesario
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

    // 🧠 Buscar nombre y segmento desde la tabla contactos si existe
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

    // 🧠 Detectar intención para actualizar segmento si aplica
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
        messages: [
          { role: 'system', content: intencionPrompt },
        ],
      });

      const intencion = intencionRes.choices[0].message?.content?.toLowerCase().trim() || '';

      if (
        ['comprar', 'compra', 'pagar', 'agendar', 'reservar', 'confirmar'].some(palabra =>
          intencion.includes(palabra)
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

    // 🧠 Detectar emoción
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
        messages: [
          { role: 'system', content: emotionPrompt },
        ],
      });

      emocion = emotionRes.choices[0].message?.content?.trim().toLowerCase() || 'neutral';
    } catch (e) {
      console.warn('⚠️ No se pudo analizar emoción:', e);
    }

    // 💾 Guardar mensaje y respuesta
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, emotion)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3, $4)`,
      [tenant.id, userInput, fromNumber, emocion]
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

    const response = new twiml.VoiceResponse();
    response.say({ voice: voiceName, language: voiceLang }, respuesta);

    if (!finConversacion) {
      response.gather({
        input: ['speech'],
        action: '/webhook/voice-response',
        method: 'POST',
        language: voiceLang,
        speechTimeout: 'auto',
      });
    } else {
      response.say(
        { voice: voiceName, language: voiceLang },
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
