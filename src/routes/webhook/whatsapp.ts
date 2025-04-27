import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

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
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE twilio_number = $1', [numero]);
    const tenant = tenantRes.rows[0];
    if (!tenant) {
      console.warn('🔴 Negocio no encontrado para número:', numero);
      return res.sendStatus(404);
    }

    const nombreNegocio = tenant.name || 'nuestro negocio';
    const promptBase = tenant.prompt || 'Eres un asistente útil para clientes en WhatsApp.';
    const saludo = `Soy Amy, bienvenido a ${nombreNegocio}.`;
    const prompt = `${saludo}\n${promptBase}`;

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
    let respuestaFAQ = null;
    for (const faq of faqs) {
      if (mensajeUsuario.includes(normalizarTexto(faq.pregunta))) {
        respuestaFAQ = faq.respuesta;
        break;
      }
    }

    let respuesta = null;

    if (respuestaFAQ) {
      respuesta = respuestaFAQ;
    } else {
      respuesta = buscarRespuestaDesdeFlows(flows, userInput);
    }

    if (!respuesta) {
      console.log("🤖 Consultando a OpenAI...");
      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userInput },
        ],
      });
      respuesta = completion.choices[0]?.message?.content || 'Lo siento, no entendí eso.';
    }

    // 🧠 Inteligencia de ventas
    if (userInput) {
      try {
        const { intencion, nivel_interes } = await detectarIntencion(userInput);

        await pool.query(
          `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenant.id, fromNumber, 'whatsapp', userInput, intencion, nivel_interes]
        );

        console.log("✅ Intención detectada y guardada:", intencion, nivel_interes);

        // 📩 Programar seguimiento si es lead caliente
        if (nivel_interes >= 4) {
          const configRes = await pool.query(
            `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
            [tenant.id]
          );
          const config = configRes.rows[0];

          if (config) {
            let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
            const intencionDetectada = intencion.toLowerCase();

            if (intencionDetectada.includes('precio') && config.mensaje_precio) {
              mensajeSeguimiento = config.mensaje_precio;
            } else if (intencionDetectada.includes('agendar') && config.mensaje_agendar) {
              mensajeSeguimiento = config.mensaje_agendar;
            } else if (intencionDetectada.includes('ubicacion') && config.mensaje_ubicacion) {
              mensajeSeguimiento = config.mensaje_ubicacion;
            }

            const fechaEnvio = new Date();
            fechaEnvio.setMinutes(fechaEnvio.getMinutes() + (config.minutos_espera || 5));

            await pool.query(
              `INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
               VALUES ($1, $2, $3, $4, $5, false)`,
              [tenant.id, 'whatsapp', fromNumber, mensajeSeguimiento, fechaEnvio]
            );

            console.log("📤 Mensaje de seguimiento programado:", mensajeSeguimiento);
          }
        }

      } catch (err) {
        console.error("❌ Error analizando intención o programando seguimiento:", err);
      }
    }

    // 💾 Guardar mensaje del usuario
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'whatsapp', $3)`,
      [tenant.id, userInput, fromNumber]
    );

    // 💾 Guardar interacción
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, $2, NOW())`,
      [tenant.id, 'whatsapp']
    );

    // 💾 Guardar respuesta del bot
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'whatsapp')`,
      [tenant.id, respuesta]
    );

    // 🔢 Incrementar contador
    await incrementarUsoPorNumero(numero);

    // 📤 Enviar respuesta a WhatsApp
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
