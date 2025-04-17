import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import OpenAI from 'openai';

const router = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

router.post('/', async (req, res) => {
  const from = req.body.To || '';
  const numero = from.replace('tel:', '');
  const userInput = req.body.SpeechResult || 'No se recibió mensaje.';

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    const prompt = tenant.prompt || 'Eres un asistente telefónico amigable y profesional.';
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
    });

    const respuesta = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';

    const response = new twiml.VoiceResponse();
    response.say(
      { voice: tenant.voice_name || 'alice', language: tenant.voice_language || 'es-ES' },
      respuesta
    );
    response.pause({ length: 1 });
    response.hangup();

    res.type('text/xml');
    res.send(response.toString());
  } catch (err) {
    console.error('❌ Error en voice-response:', err);
    res.sendStatus(500);
  }
});

export default router;
