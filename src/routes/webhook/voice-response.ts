// ✅ src/routes/webhook/voice-response.ts
import { Router } from 'express';
import { twiml } from 'twilio';
import axios from 'axios';
import pool from '../../lib/db';
import { guardarAudioEnCDN } from '../../utils/uploadAudioToCDN';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import twilio from 'twilio';

const router = Router();

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
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

    // 🚫 Evitar responder si la membresía está inactiva
    if (!tenant.membresia_activa) {
      console.log(`⛔ Llamada bloqueada para ${tenant.name}, membresía inactiva.`);
      const response = new twiml.VoiceResponse();
      response.say(
        { voice: 'Polly.Conchita', language: 'es-ES' },
        'Tu membresía está inactiva. Por favor actualízala para volver a utilizar este servicio. ¡Gracias!'
      );
      response.hangup();
      return res.type('text/xml').send(response.toString());
    }

    const configRes = await pool.query(
      'SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 LIMIT 1',
      [tenant.id, 'voz']
    );
    const config = configRes.rows[0];
    if (!config) return res.sendStatus(404);

    const idioma = config.idioma || 'es-ES';
    const voiceId = config.voice_name || 'EXAVITQu4vr4xnSDxMaL';
    const nombreNegocio = tenant.name || 'nuestro negocio';
    const saludoHora = obtenerSaludoHora();
    const saludoInicial = `${saludoHora}, mi nombre es Amy, asistente de ${nombreNegocio}.`;

    const response = new twiml.VoiceResponse();

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

    const { default: OpenAI } = await import('openai');
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
      await pool.query(
        `UPDATE uso_mensual
        SET usados = usados + $1
        WHERE tenant_id = $2 AND canal = 'voz' AND mes = date_trunc('month', CURRENT_DATE)`,
        [tokensConsumidos, tenant.id]
      );
    }

    // Añadir pausas naturales con SSML
    const textoConPausas = respuesta
      .replace(/\.\s*/g, '. <break time="400ms"/> ')
      .replace(/,\s*/g, ', <break time="300ms"/> ');

    // Generar audio con ElevenLabs usando SSML
    const ssmlTexto = `<speak>${textoConPausas}</speak>`;

    const audioRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?model_id=eleven_monolingual_v1`, // ✅ model_id aquí
      ssmlTexto,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY!,
          "Content-Type": "application/ssml+xml",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
      }
    );

    const audioBuffer = Buffer.from(audioRes.data);
    const audioUrl = await guardarAudioEnCDN(audioBuffer, tenant.id);

    // Guardar mensajes e interacción
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)
       ON CONFLICT DO NOTHING`,
      [tenant.id, userInput, fromNumber || 'anónimo'] // Aseguramos que siempre haya from_number
    );    

    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'bot', $2, NOW(), 'voice', $3)
       ON CONFLICT DO NOTHING`,
      [tenant.id, respuesta, numero || 'sistema'] // Puedes guardar el número del bot o "sistema"
    );

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voice', NOW())`,
      [tenant.id]
    );

    await incrementarUsoPorNumero(numero);

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
        const linkRes = await pool.query(
          `SELECT url, nombre FROM links_utiles
           WHERE tenant_id = $1 AND tipo = $2
           ORDER BY created_at DESC LIMIT 1`,
          [tenant.id, intencion]
        );

        const link = linkRes.rows[0]?.url;
        const nombreLink = linkRes.rows[0]?.nombre;

        if (link) {
          const client = twilio(process.env.TWILIO_SID!, process.env.TWILIO_AUTH_TOKEN!);
          await client.messages.create({
            from: numero,
            to: fromNumber,
            body: `📎 ${nombreLink}: ${link}`,
          });
          console.log(`✅ SMS enviado con link de ${intencion}`);
        }
      }
    } catch (e) {
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
    } else {
      response.say(
        { voice: 'Polly.Conchita', language: idioma },
        'Gracias por tu llamada. ¡Hasta luego!'
      );
      response.hangup();
    }

    res.type('text/xml').send(response.toString());
  } catch (err) {
    console.error('❌ Error en voice-response:', err);
    res.sendStatus(500);
  }
});

export default router;
