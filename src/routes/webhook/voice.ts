// src/routes/webhook/voice.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';

const router = Router();

// Normaliza 'es'/'en' → códigos que Twilio acepta
const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es')) return 'es-ES' as const;
  if (c.startsWith('en')) return 'en-US' as const;
  if (c.startsWith('pt')) return 'pt-BR' as const;
  return 'es-ES' as const;
};

// ⚠️ Twilio <Say> NO acepta '<', '>', '&' sin escapar y a veces SSML.
// Sanitizamos para evitar 13520 + 12200.
const sanitizeForSay = (s: string) =>
  (s || '')
    .replace(/[<>&]/g, ' ')         // evita romper el XML
    .replace(/\s+/g, ' ')           // limpia espacios raros
    .trim()
    .slice(0, 1500);                // límite prudente

// Helper: última voice_config del tenant (canal 'voz')
async function getVoiceConfig(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM voice_configs
     WHERE tenant_id = $1 AND canal = 'voz'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return rows[0] || null;
}

router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString().replace(/^tel:/, '');

  try {
    const tRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1 LIMIT 1',
      [to]
    );
    const tenant = tRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    if (!tenant.membresia_activa) {
      const vr = new twiml.VoiceResponse();
      vr.say(
        { voice: 'alice', language: 'es-ES' as any },
        'Tu membresía está inactiva. Por favor actualízala para continuar. ¡Gracias!'
      );
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    const cfg = await getVoiceConfig(tenant.id);
    if (!cfg) return res.sendStatus(404);

    const locale = toTwilioLocale(cfg.idioma || 'es-ES');
    const welcomeRaw = cfg.welcome_message || 'Hola, ¿en qué puedo ayudarte?';
    const welcome = sanitizeForSay(welcomeRaw);

    // Si quieres forzar Polly (si está activado en tu cuenta):
    // const voiceName: any = 'Polly.Conchita';
    // Si no, usa 'alice' (más universal y estable)
    const voiceName: any = 'alice';

    const vr = new twiml.VoiceResponse();

    const gather = vr.gather({
      input: ['speech'] as any,
      action: '/webhook/voice-response',
      method: 'POST',
      language: locale as any,
      speechTimeout: 'auto',
      ...(cfg.voice_hints ? { hints: String(cfg.voice_hints) } : {})
    });

    // Mensaje de bienvenida
    gather.say({ language: locale as any, voice: voiceName }, welcome);

    // Si el usuario no responde, despedimos cortésmente
    vr.say(
      { language: locale as any, voice: voiceName },
      locale.startsWith('es')
        ? 'No escuché nada. ¡Hasta luego!'
        : "I didn't hear anything. Goodbye!"
    );

    res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('❌ Error en webhook de voz:', err);
    res.sendStatus(500);
  }
});

export default router;
