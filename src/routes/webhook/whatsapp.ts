// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

// 🧠 Normalizar texto
function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// 🧠 Buscar en Flows
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

// 🔎 Detectar intención de compra
async function detectarIntencion(mensaje: string) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const prompt = `
Analiza este mensaje de un cliente:

"${mensaje}"

Identifica:
- Intención de compra (por ejemplo: pedir precios, reservar cita, ubicación, cancelar, etc.).
- Nivel de interés (de 1 a 5, siendo 5 "muy interesado en comprar").

Responde solo en JSON. Ejemplo:
{
  "intencion": "preguntar precios",
  "nivel_interes": 4
}
`;
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

router.post('/', async (req: Request, res: Response) => {
  console.log("📩 Webhook recibido:", req.body);

  const to = req.body.To || '';
  const from = req.body.From || '';
  const numero = to.replace('whatsapp:', '').replace('tel:', '');
  const fromNumber = from.replace('whatsapp:', '').replace('tel:', '');
  const userInput = req.body.Body || '';

  try {
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE twilio_number = $1 LIMIT 1', [numero]);
    const tenant = tenantRes.rows[0];

    if (!tenant) {
      console.warn('🔴 Negocio no encontrado para número:', numero);
      return res.sendStatus(404);
    }

    const saludo = `Soy Amy, bienvenido a ${tenant.name || 'nuestro negocio'}.`;
    const promptBase = `${saludo}\n${getPromptPorCanal('whatsapp', tenant)}`;
    const bienvenida = getBienvenidaPorCanal('whatsapp', tenant);

    // 📥 Leer Flows
    let flows: any[] = [];
    try {
      const flowsRes = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant.id]);
      const raw = flowsRes.rows[0]?.data;
      flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar los flujos:', e);
    }

    // 📥 Leer FAQs
    let faqs: any[] = [];
    try {
      const faqsRes = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant.id]);
      faqs = faqsRes.rows || [];
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar las FAQs:', e);
    }

    console.log("📝 Mensaje recibido:", userInput);
    const mensajeUsuario = normalizarTexto(userInput);
    let respuesta = null;

    const respuestaFAQ = faqs.find(faq => mensajeUsuario.includes(normalizarTexto(faq.pregunta)));
    if (respuestaFAQ) {
      respuesta = respuestaFAQ.respuesta;
    } else {
      respuesta = buscarRespuestaDesdeFlows(flows, userInput);
    }

    if (!respuesta) {
      console.log("🤖 Consultando a OpenAI...");
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: promptBase },
          { role: 'user', content: userInput },
        ],
      });

      respuesta = completion.choices[0]?.message?.content?.trim() || bienvenida || 'Lo siento, no entendí eso.';
    }

    // 🧠 Inteligencia de ventas
    try {
      const { intencion, nivel_interes } = await detectarIntencion(userInput);

      // 🎯 Si el cliente es un lead y la intención es fuerte, subirlo a "cliente"
      const intencionLower = intencion.toLowerCase();

      if (
        ['comprar', 'compra', 'pagar', 'agendar', 'reservar', 'confirmar'].some(palabra =>
          intencionLower.includes(palabra)
        )
      ) {
        await pool.query(
          `UPDATE clientes
          SET segmento = 'cliente'
          WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`,
          [tenant.id, fromNumber]
        );
      }

      await pool.query(
        `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
         VALUES ($1, $2, 'whatsapp', $3, $4, $5)`,
        [tenant.id, fromNumber, userInput, intencion, nivel_interes]
      );

      console.log("✅ Intención detectada y guardada:", intencion, nivel_interes);

      // 📩 Seguimiento automático
      if (nivel_interes >= 4) {
        const configRes = await pool.query(
          `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
          [tenant.id]
        );
        const config = configRes.rows[0];

        if (config) {
          let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
          const intencionLower = intencion.toLowerCase();

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

          console.log("📤 Seguimiento programado:", mensajeSeguimiento);
        }
      }
    } catch (err) {
      console.error("❌ Error en inteligencia de ventas:", err);
    }

    // 🧠 Buscar datos del contacto previo si existe
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

    // 💾 Guardar mensaje usuario y bot
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

    // 🔢 Incrementar contador de uso
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
