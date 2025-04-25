import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import OpenAI from 'openai';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';

const router = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

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

    // 🔮 Generar respuesta con OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
    });

    const respuesta = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';

    // 🔍 Detectar emoción
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

    const emocion = emotionRes.choices[0].message?.content?.trim().toLowerCase() || 'neutral';

    // 💾 Guardar mensaje del cliente con emoción
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, emotion)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3, $4)`,
      [tenant.id, userInput, fromNumber, emocion]
    );

    // 💾 Guardar respuesta del bot
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'voice')`,
      [tenant.id, respuesta]
    );

    // 💾 Registrar interacción
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voice', NOW())`,
      [tenant.id]
    );

    // 🔢 Sumar uso
    await incrementarUsoPorNumero(numero);

    // 🧠 Detectar intención de cierre
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
