import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage'; // ✅ importar función

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

router.post('/', async (req: Request, res: Response) => {
  console.log("📩 Webhook recibido:", req.body);

  const to = req.body.To || '';
  const from = req.body.From || '';
  const numero = to.replace('whatsapp:', '').replace('tel:', ''); // ✅ Número del negocio (Twilio)
  const fromNumber = from.replace('whatsapp:', '').replace('tel:', ''); // ✅ Número del cliente
  const userInput = req.body.Body || '';

  console.log('🔍 Buscando negocio con número:', numero);

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_number = $1',
      [numero]
    );
    const tenant = tenantRes.rows[0];

    if (!tenant) {
      console.warn('🔴 Negocio no encontrado para número:', numero);
      return res.sendStatus(404);
    }

    const prompt = tenant.prompt || 'Eres un asistente útil para clientes en WhatsApp.';

    // 🔮 Obtener respuesta de OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
    });

    const respuesta = completion.choices[0]?.message?.content || 'Lo siento, no entendí eso.';

    // 💾 Guardar mensaje del usuario
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'whatsapp', $3)`,
      [tenant.id, userInput, fromNumber]
    );

    // 💾 Guardar respuesta del bot
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'whatsapp')`,
      [tenant.id, respuesta]
    );

    // 🔢 Incrementar uso real
    await incrementarUsoPorNumero(numero); // ✅ sumamos 1 solo si es canal real

    // 📤 Responder a WhatsApp
    const twiml = new MessagingResponse();
    twiml.message(respuesta);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('❌ Error en webhook WhatsApp:', error);
    res.sendStatus(500);
  }
});

export default router;
