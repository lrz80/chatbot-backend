// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function buscarRespuestaDesdeFlows(flows: any[], mensajeUsuario: string): string | null {
  const normalizado = normalizarTexto(mensajeUsuario);
  for (const flujo of flows) {
    for (const opcion of flujo.opciones || []) {
      if (normalizarTexto(opcion.texto || '') === normalizado) {
        return opcion.respuesta || opcion.submenu?.mensaje || null;
      }
      if (opcion.submenu) {
        for (const sub of opcion.submenu.opciones || []) {
          if (normalizarTexto(sub.texto || '') === normalizado) {
            return sub.respuesta || null;
          }
        }
      }
    }
  }
  return null;
}

async function detectarIntencion(mensaje: string) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
  const prompt = `Analiza este mensaje de un cliente:\n\n"${mensaje}"\n\nIdentifica:\n- Intención de compra (por ejemplo: pedir precios, reservar cita, ubicación, cancelar, etc.).\n- Nivel de interés (de 1 a 5, siendo 5 "muy interesado en comprar").\n\nResponde solo en JSON. Ejemplo:\n{\n  "intencion": "preguntar precios",\n  "nivel_interes": 4\n}`;

  const respuesta = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });

  const content = respuesta.choices[0]?.message?.content || '{}';
  const data = JSON.parse(content);
  return {
    intencion: data.intencion || 'no_detectada',
    nivel_interes: data.nivel_interes || 1,
  };
}

function buscarRespuestaSimilitudFaqs(faqs: any[], mensaje: string): string | null {
  const msg = normalizarTexto(mensaje);
  for (const faq of faqs) {
    const pregunta = normalizarTexto(faq.pregunta);
    if (msg.includes(pregunta) || pregunta.includes(msg)) {
      return faq.respuesta;
    }
  }
  return null;
}

router.post('/', async (req: Request, res: Response) => {
  const to = req.body.To || '';
  const from = req.body.From || '';
  const numero = to.replace('whatsapp:', '').replace('tel:', '');
  const fromNumber = from.replace('whatsapp:', '').replace('tel:', '');
  const userInput = req.body.Body || '';

  try {
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE twilio_number = $1 LIMIT 1', [numero]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    const promptBase = getPromptPorCanal('whatsapp', tenant);
    const canal = 'whatsapp';

    let flows: any[] = [];
    try {
      const flowsRes = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant.id]);
      const raw = flowsRes.rows[0]?.data;
      flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}

    let faqs: any[] = [];
    try {
      const faqsRes = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant.id]);
      faqs = faqsRes.rows || [];
    } catch {}

    const mensajeUsuario = normalizarTexto(userInput);
    let respuesta = null;

    if (['hola', 'buenas', 'hello', 'hi', 'hey'].includes(mensajeUsuario)) {
      respuesta = getBienvenidaPorCanal('whatsapp', tenant);
    } else {
      respuesta = buscarRespuestaSimilitudFaqs(faqs, mensajeUsuario) || buscarRespuestaDesdeFlows(flows, userInput);
    }

    if (!respuesta) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: promptBase },
          { role: 'user', content: userInput },
        ],
      });
      respuesta = completion.choices[0]?.message?.content?.trim() || getBienvenidaPorCanal('whatsapp', tenant);
    }

    try {
      const { intencion, nivel_interes } = await detectarIntencion(userInput);
      const intencionLower = intencion.toLowerCase();

      if (['comprar', 'compra', 'pagar', 'agendar', 'reservar', 'confirmar'].some(p => intencionLower.includes(p))) {
        await pool.query(
          `UPDATE clientes SET segmento = 'cliente' WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`,
          [tenant.id, fromNumber]
        );
      }

      await pool.query(
        `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
         VALUES ($1, $2, 'whatsapp', $3, $4, $5)`,
        [tenant.id, fromNumber, userInput, intencion, nivel_interes]
      );

      if (nivel_interes >= 4) {
        const configRes = await pool.query(
          `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
          [tenant.id]
        );
        const config = configRes.rows[0];

        if (config) {
          let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
          if (intencionLower.includes('precio') && config.mensaje_precio) mensajeSeguimiento = config.mensaje_precio;
          else if (intencionLower.includes('agendar') && config.mensaje_agendar) mensajeSeguimiento = config.mensaje_agendar;
          else if (intencionLower.includes('ubicacion') && config.mensaje_ubicacion) mensajeSeguimiento = config.mensaje_ubicacion;

          const fechaEnvio = new Date();
          fechaEnvio.setMinutes(fechaEnvio.getMinutes() + (config.minutos_espera || 5));

          await pool.query(
            `INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
             VALUES ($1, 'whatsapp', $2, $3, $4, false)`,
            [tenant.id, fromNumber, mensajeSeguimiento, fechaEnvio]
          );
        }
      }
    } catch (err) {
      console.error("❌ Error en inteligencia de ventas:", err);
    }

    const contactoRes = await pool.query(
      `SELECT nombre, segmento FROM contactos WHERE tenant_id = $1 AND telefono = $2 LIMIT 1`,
      [tenant.id, fromNumber]
    );
    const contactoPrevio = contactoRes.rows[0];
    const nombreDetectado = contactoPrevio?.nombre || req.body.ProfileName || null;
    const segmentoDetectado = contactoPrevio?.segmento || 'lead';

    await pool.query(
      `INSERT INTO clientes (tenant_id, canal, contacto, creado, nombre, segmento)
      VALUES ($1, 'whatsapp', $2, NOW(), $3, $4)
      ON CONFLICT (contacto) DO UPDATE SET
        nombre = COALESCE(EXCLUDED.nombre, clientes.nombre),
        segmento = CASE
          WHEN clientes.segmento = 'lead' AND EXCLUDED.segmento = 'cliente' THEN 'cliente'
          ELSE clientes.segmento
        END`,
      [tenant.id, fromNumber, nombreDetectado, segmentoDetectado]
    );

    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'whatsapp', $3)`,
      [tenant.id, userInput, fromNumber]
    );
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'whatsapp')`,
      [tenant.id, respuesta]
    );
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'whatsapp', NOW())`,
      [tenant.id]
    );

    await incrementarUsoPorNumero(numero);

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
