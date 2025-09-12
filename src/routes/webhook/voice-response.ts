// ✅ src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import axios from 'axios';
import pool from '../../lib/db';
import { guardarAudioEnCDN } from '../../utils/uploadAudioToCDN';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import Twilio from 'twilio';

const router = Router();

function obtenerSaludoHora(): string {
  const hora = new Date().getHours();
  if (hora < 12) return 'Buenos días';
  if (hora < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

// Normaliza 'es'/'en' → códigos que Twilio acepta
const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es')) return 'es-ES' as const;
  if (c.startsWith('en')) return 'en-US' as const;
  if (c.startsWith('pt')) return 'pt-BR' as const;
  return 'es-ES' as const;
};

router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '') as string;
  const from = (req.body.From || '') as string;
  const numero = to.replace(/^tel:/, '');
  const fromNumber = from.replace(/^tel:/, '');
  const userInput = (req.body.SpeechResult || '').toString().trim();

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1 LIMIT 1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    // 🛑 Evitar responder si la membresía está inactiva
    if (!tenant.membresia_activa) {
      const vr = new twiml.VoiceResponse();
      vr.say(
        { voice: 'Polly.Conchita', language: 'es-ES' as any },
        'Tu membresía está inactiva. Por favor actualízala para volver a utilizar este servicio. ¡Gracias!'
      );
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    // 📥 Config de voz (usar canal 'voz' y la más reciente)
    const configRes = await pool.query(
      `SELECT * FROM voice_configs
       WHERE tenant_id = $1 AND canal = 'voz'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [tenant.id]
    );
    const cfg = configRes.rows[0];
    if (!cfg) return res.sendStatus(404);

    const idioma = (cfg.idioma || 'es-ES') as string;
    const locale = toTwilioLocale(idioma);
    const voiceId = (cfg.voice_name as string) || 'EXAVITQu4vr4xnSDxMaL'; // fallback ElevenLabs
    const nombreNegocio = tenant.name || 'nuestro negocio';
    const saludoInicial = `${obtenerSaludoHora()}, mi nombre es Amy, asistente de ${nombreNegocio}.`;

    const vr = new twiml.VoiceResponse();

    // Primera entrada: no hay SpeechResult → saluda y vuelve a pedir voz
    if (!userInput) {
      vr.say({ voice: 'Polly.Conchita', language: locale as any }, saludoInicial);
      vr.gather({
        input: ['speech'] as any,
        action: '/webhook/voice-response', // 👈 asegúrate de apuntar aquí desde voice.ts también
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
      });
      return res.type('text/xml').send(vr.toString());
    }

    // 🤖 Prompt del asistente
    const prompt =
      (cfg.system_prompt as string)?.trim() ||
      `Eres Amy, una asistente telefónica de voz cálida, clara y natural. Responde en frases cortas y con una actitud amigable. Nunca digas que eres un asistente virtual, responde como si fueras parte real del equipo de ${nombreNegocio}. Si el cliente da las gracias o quiere terminar, despídete cordialmente.`.trim();

    // --- OpenAI (ligero y estable) ---
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    let respuesta = 'Lo siento, no entendí eso.';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userInput },
        ],
      });

      respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;

      // Uso mensual (UPSERT seguro) → canal 'voz'
      const tokens = completion.usage?.total_tokens || 0;
      if (tokens > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, 'voz', date_trunc('month', CURRENT_DATE), $2)
           ON CONFLICT (tenant_id, canal, mes)
           DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, tokens]
        );
      }
    } catch (e) {
      console.warn('⚠️ OpenAI falló, uso fallback de respuesta:', e);
    }

    // 🔊 SSML + ElevenLabs (mejor soporte multi-idioma)
    const ssml = `<speak>${
      respuesta
        .replace(/\.\s*/g, '. <break time="400ms"/> ')
        .replace(/,\s*/g, ', <break time="300ms"/> ')
    }</speak>`;

    let audioUrl: string | null = null;
    try {
      const audioRes = await axios.post(
        // 👇 usa modelo multilingüe
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?model_id=eleven_multilingual_v2`,
        ssml,
        {
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY!,
            'Content-Type': 'application/ssml+xml',
            Accept: 'audio/mpeg',
          },
          responseType: 'arraybuffer',
        }
      );
      const audioBuffer = Buffer.from(audioRes.data);
      audioUrl = await guardarAudioEnCDN(audioBuffer, tenant.id); // debe servir audio/mpeg por HTTPS público
    } catch (e: any) {
      // Logs útiles (no <Buffer ...>)
      let status = e?.response?.status;
      let headers = e?.response?.headers;
      let body = '';
      try {
        const raw = e?.response?.data;
        body = Buffer.isBuffer(raw) ? raw.toString('utf8') : JSON.stringify(raw);
      } catch {}
      console.warn('⚠️ ElevenLabs TTS falló, uso <Say>:', {
        status,
        requestId: headers?.['x-request-id'] || headers?.['x-requestid'],
        body
      });
    }

    // 🗃 Guardar conversación
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voz', $3)`,
      [tenant.id, userInput, fromNumber || 'anónimo']
    );
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'assistant', $2, NOW(), 'voz', $3)`,
      [tenant.id, respuesta, numero || 'sistema']
    );
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voz', NOW())`,
      [tenant.id]
    );

    await incrementarUsoPorNumero(numero);

    // 🔗 Detectar intención y mandar SMS con link útil (si aplica)
    try {
      const intentPrompt =
        `El cliente dijo: "${userInput}". ¿Qué intención tiene? ` +
        `Responde solo con una palabra entre: reservar, comprar, soporte, web, otro.`;
      const intentRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: intentPrompt }],
      });
      const intencion =
        intentRes.choices[0].message?.content?.toLowerCase().trim() || '';

      if (['reservar', 'comprar', 'soporte', 'web'].includes(intencion)) {
        const linkRes = await pool.query(
          `SELECT url, nombre FROM links_utiles
           WHERE tenant_id = $1 AND tipo = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [tenant.id, intencion]
        );
        const link = linkRes.rows[0]?.url;
        const nombreLink = linkRes.rows[0]?.nombre;

        if (link) {
          const smsFrom = tenant.twilio_sms_number || numero; // asegúrate que sea un número SMS-capable (E.164)
          const client = Twilio(
            process.env.TWILIO_ACCOUNT_SID!,
            process.env.TWILIO_AUTH_TOKEN!
          );
          await client.messages.create({
            from: smsFrom,
            to: fromNumber,
            body: `📎 ${nombreLink || 'Enlace'}: ${link}`,
          });
          console.log(`✅ SMS enviado con link (${intencion})`);
        }
      }
    } catch (e) {
      console.warn('⚠️ No se pudo detectar intención o enviar SMS:', e);
    }

    // 🧾 ¿Terminamos?
    const finConversacion = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

    if (audioUrl) {
      vr.play(audioUrl);
    } else {
      vr.say({ voice: 'Polly.Conchita', language: locale as any }, respuesta);
    }

    if (!finConversacion) {
      vr.gather({
        input: ['speech'] as any,
        action: '/webhook/voice-response',
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
      });
    } else {
      vr.say(
        { voice: 'Polly.Conchita', language: locale as any },
        idioma.startsWith('es')
          ? 'Gracias por tu llamada. ¡Hasta luego!'
          : 'Thanks for calling. Goodbye!'
      );
      vr.hangup();
    }

    res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('❌ Error en voice-response:', err);
    res.sendStatus(500);
  }
});

export default router;
