// 📁 src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

router.post('/', async (req: Request, res: Response) => {
  console.log("📩 Webhook recibido:", req.body);

  const from = req.body.To || ''; // ✅ CAMBIO: usamos "To" en lugar de "From"
  const numero = from.replace('whatsapp:', '').replace('tel:', '').trim();
  console.log("🔍 Buscando negocio con número:", numero);

  const userInput = req.body.Body || '';

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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
    });

    const respuesta = completion.choices[0]?.message?.content || 'Lo siento, no entendí eso.';

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
