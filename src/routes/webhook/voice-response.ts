// ✅ src/routes/webhook/voice-response.ts
import { Router } from 'express';
import { twiml } from 'twilio';
import axios from 'axios';
import pool from '../../lib/db';
import { guardarAudioEnCDN } from '../../utils/uploadAudioToCDN';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';

const router = Router();

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/\u0300-\u036f/g, '').trim();
}

function obtenerSaludoHora(): string {
  const hora = new Date().getHours();
  if (hora < 12) return 'Buenos días';
  if (hora < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

async function enviarSMS(to: string, from: string, body: string) {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({ To: to, From: from, Body: body }),
    {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID!,
        password: process.env.TWILIO_AUTH_TOKEN!,
      },
    }
  );
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

    const prompt = `${saludoInicial}\n${config.system_prompt || 'Eres un asistente telefónico amigable y profesional.'}`;
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
    const textoFinal = `${respuesta}`;

    // 🔍 Detección de intención
    const intencionPrompt = `
    Mensaje del cliente:
    "${userInput}"
    
    ¿Tiene intención de comprar o agendar?
    
    Responde solo con una palabra: comprar, reservar, cancelar, preguntar, otro.
    `;
    const intencionRes = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'system', content: intencionPrompt }],
    });

    const intencion = intencionRes.choices[0].message?.content?.toLowerCase().trim() || '';

    // ✉️ Enviar SMS si aplica
    if (['comprar', 'reservar', 'agendar'].includes(intencion)) {
      const smsTexto = 'Reserva aquí 👉 https://www.aamy.ai/book';
      await enviarSMS(fromNumber, numero, smsTexto);
    }

    const voiceId = config.voice_name || 'EXAVITQu4vr4xnSDxMaL';
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

    res.type('text/xml').send(response.toString());
  } catch (err) {
    console.error('❌ Error en voice-response:', err);
    res.sendStatus(500);
  }
});

export default router;
