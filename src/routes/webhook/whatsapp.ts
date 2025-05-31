// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido, buscarRespuestaDesdeFlowsTraducido } from '../../lib/respuestasTraducidas';
import { enviarWhatsApp } from '../../lib/senders/whatsapp';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
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

router.post('/', async (req: Request, res: Response) => {
  console.log("📩 Webhook recibido:", req.body);

  const twiml = new MessagingResponse();
  res.type('text/xml').send(new MessagingResponse().toString());

  setTimeout(async () => {
    try {
      await procesarMensajeWhatsApp(req.body);
    } catch (error) {
      console.error("❌ Error procesando mensaje:", error);
    }
  }, 0);
});

export default router;

async function procesarMensajeWhatsApp(body: any) {
  const to = body.To || '';
  const from = body.From || '';
  const numero = to.replace('whatsapp:', '').replace('tel:', '');
  const fromNumber = from.replace('whatsapp:', '').replace('tel:', '');
  const userInput = body.Body || '';

  const tenantRes = await pool.query('SELECT * FROM tenants WHERE twilio_number = $1 LIMIT 1', [numero]);
  const tenant = tenantRes.rows[0];
  if (!tenant) return;

  const idioma = await detectarIdioma(userInput);
  const promptBase = getPromptPorCanal('whatsapp', tenant, idioma);
  let respuesta: any = getBienvenidaPorCanal('whatsapp', tenant, idioma);
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
  if (["hola", "buenas", "hello", "hi", "hey"].includes(mensajeUsuario)) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idioma);
  } else {
    respuesta = await buscarRespuestaSimilitudFaqsTraducido(faqs, mensajeUsuario, idioma)
      || await buscarRespuestaDesdeFlowsTraducido(flows, mensajeUsuario, idioma);
  }

  if (!respuesta) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: 'system', content: promptBase },
        { role: 'user', content: userInput },
      ],
    });
    respuesta = completion.choices[0]?.message?.content?.trim() || getBienvenidaPorCanal('whatsapp', tenant, idioma);
    const tokensConsumidos = completion.usage?.total_tokens || 0;
    if (tokensConsumidos > 0) {
      await pool.query(
        `UPDATE uso_mensual SET usados = usados + $1 WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`,
        [tokensConsumidos, tenant.id]
      );
    }
  }

  if (respuesta) {
    const idiomaRespuesta = await detectarIdioma(respuesta);
    if (idiomaRespuesta !== idioma) {
      respuesta = await traducirMensaje(respuesta, idioma);
    }
  }

  await pool.query(
    `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
     VALUES ($1, 'user', $2, NOW(), $3, $4)`,
    [tenant.id, userInput, canal, fromNumber]
  );

  // ✅ Incrementar solo una vez por mensaje recibido
  const inicio = new Date(tenant.membresia_inicio);
  const fin = new Date(inicio);
  fin.setMonth(inicio.getMonth() + 1);
  await pool.query(
    `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
     VALUES ($1, 'whatsapp', $2, 1)
     ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1`,
    [tenant.id, inicio.toISOString().substring(0,10)]
  );

  // Insertar mensaje bot (esto no suma a uso)
  await pool.query(
    `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
     VALUES ($1, 'bot', $2, NOW(), $3)`,
    [tenant.id, respuesta, canal]
  );

  await enviarWhatsApp(fromNumber, respuesta, tenant.id);
  console.log("📬 Respuesta enviada vía Twilio:", respuesta);

  await pool.query(
    `INSERT INTO interactions (tenant_id, canal, created_at) VALUES ($1, $2, NOW())`,
    [tenant.id, canal]
  );

  try {
    const { intencion, nivel_interes } = await detectarIntencion(userInput);
    const intencionLower = intencion.toLowerCase();
    if (["comprar", "compra", "pagar", "agendar", "reservar", "confirmar"].some(p => intencionLower.includes(p))) {
      await pool.query(`UPDATE clientes SET segmento = 'cliente' WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`, [tenant.id, fromNumber]);
    }
    await pool.query(`INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes) VALUES ($1, $2, $3, $4, $5, $6)`, [tenant.id, fromNumber, canal, userInput, intencion, nivel_interes]);
  } catch (err) {
    console.error("⚠️ Error en inteligencia de ventas:", err);
  }

  const contactoRes = await pool.query(`SELECT nombre, segmento FROM contactos WHERE tenant_id = $1 AND telefono = $2 LIMIT 1`, [tenant.id, fromNumber]);
  const contactoPrevio = contactoRes.rows[0];
  const nombreDetectado = contactoPrevio?.nombre || body.ProfileName || null;
  const segmentoDetectado = contactoPrevio?.segmento || 'lead';
  await pool.query(`INSERT INTO clientes (tenant_id, canal, contacto, creado, nombre, segmento) VALUES ($1, $2, $3, NOW(), $4, $5) ON CONFLICT (contacto) DO UPDATE SET nombre = COALESCE(EXCLUDED.nombre, clientes.nombre), segmento = CASE WHEN clientes.segmento = 'lead' AND EXCLUDED.segmento = 'cliente' THEN 'cliente' ELSE clientes.segmento END`, [tenant.id, canal, fromNumber, nombreDetectado, segmentoDetectado]);
}
