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
import stringSimilarity from "string-similarity";

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

async function detectarIntencion(mensaje: string) {
  const texto = mensaje.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  const saludos = [
    "hola", "hello", "buenas", "hi", "hey", "buen dia", "buenos dias", "buenas tardes", "buenas noches"
  ];

  if (saludos.includes(texto)) {
    return {
      intencion: "saludar",
      nivel_interes: 1
    };
  }

  // Solo si no fue saludo, llamamos a OpenAI
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
  const prompt = `Analiza este mensaje de un cliente:\n\n"${mensaje}"\n\nIdentifica:\n- Intención de compra (por ejemplo: pedir precios, reservar cita, ubicación, cancelar, etc.).\n- Nivel de interés (de 1 a 5, siendo 5 "muy interesado en comprar").\n\nResponde solo en JSON. Ejemplo:\n{\n  "intencion": "preguntar precios",\n  "nivel_interes": 4\n}`;

  const respuesta = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });

  const content = respuesta.choices[0]?.message?.content || '{}';
  const data = JSON.parse(content);

  return {
    intencion: data.intencion || 'no_detectada',
    nivel_interes: data.nivel_interes || 1
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

  // 🚫 No responder si la membresía está inactiva
  if (!tenant.membresia_activa) {
    console.log(`⛔ Membresía inactiva para tenant ${tenant.nombre || tenant.id}. No se responderá.`);
    return;
  }

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
    const respuestaGenerada = respuesta;
  
    function limpiarHtml(texto: string): string {
      return texto.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    }
    
    function limpiarRespuesta(texto: string): string {
      return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // quitar acentos
        .replace(/[^\w\s]/g, '') // quitar signos de puntuación
        .replace(/\s+/g, ' ') // quitar espacios dobles
        .replace(/(hola|claro|esperamos verte pronto|hay algo mas en lo que pueda ayudarte|te podemos ayudar|es facil acceder|spinzone indoor cycling)/gi, '') // frases comunes
        .trim();
    }
    
    const preguntaNormalizada = normalizarTexto(userInput);
    const respuestaGeneradaLimpia = limpiarHtml(respuestaGenerada);
    const respuestaNormalizada = limpiarRespuesta(respuestaGeneradaLimpia);
    
    const { rows: sugeridasExistentes } = await pool.query(
      `SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2`,
      [tenant.id, canal]
    );
    
    const yaExiste = sugeridasExistentes.find((faq) => {
      const preguntaNormalizadaExistente = normalizarTexto(faq.pregunta);
      const respuestaNormalizadaExistente = limpiarRespuesta(limpiarHtml(faq.respuesta_sugerida || ''));
    
      const preguntaSimilitud = stringSimilarity.compareTwoStrings(
        preguntaNormalizadaExistente,
        preguntaNormalizada
      );
    
      const respuestaSimilitud = stringSimilarity.compareTwoStrings(
        respuestaNormalizadaExistente,
        respuestaNormalizada
      );
    
      console.log("🔍 PREGUNTA:", preguntaNormalizadaExistente, "|", preguntaNormalizada);
      console.log("🔍 RESPUESTA:", respuestaNormalizadaExistente, "|", respuestaNormalizada);
      console.log("✅ Similitud pregunta:", preguntaSimilitud);
      console.log("✅ Similitud respuesta:", respuestaSimilitud);
    
      return (
        preguntaSimilitud > 0.6 ||
        respuestaSimilitud > 0.7 ||
        preguntaNormalizadaExistente.includes(preguntaNormalizada) ||
        preguntaNormalizada.includes(preguntaNormalizadaExistente) ||
        respuestaNormalizadaExistente.includes(respuestaNormalizada)
      );
    });
    
    if (yaExiste) {
      await pool.query(
        `UPDATE faq_sugeridas 
         SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
         WHERE id = $1`,
        [yaExiste.id]
      );
      console.log(`⚠️ Pregunta similar ya registrada como sugerida (ID: ${yaExiste.id})`);
    } else {
      await pool.query(
        `INSERT INTO faq_sugeridas (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha)
         VALUES ($1, $2, $3, $4, $5, false, NOW())`,
        [tenant.id, canal, preguntaNormalizada, respuestaGenerada, idioma]
      );
      console.log(`📝 Pregunta no resuelta registrada: "${preguntaNormalizada}"`);
    }    

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

  const messageId = body.MessageSid || body.SmsMessageSid || null;

  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
    VALUES ($1, 'user', $2, NOW(), $3, $4, $5)`,
    [tenant.id, userInput, canal, fromNumber || "anónimo", messageId]
  );

  // ✅ Incrementar solo una vez por mensaje recibido
  // 🔍 Obtiene membresia_inicio
  const { rows: rowsTenant } = await pool.query(
    `SELECT membresia_inicio FROM tenants WHERE id = $1`, [tenant.id]
  );
  const membresiaInicio = rowsTenant[0]?.membresia_inicio;
  if (!membresiaInicio) {
    console.error('❌ No se encontró membresia_inicio para el tenant:', tenant.id);
    return; // O maneja el error de forma adecuada
  }

  // 🔥 Calcula el ciclo de membresía actual
  const inicio = new Date(membresiaInicio);
  const ahora = new Date();
  const diffInMonths = Math.floor(
    (ahora.getFullYear() - inicio.getFullYear()) * 12 + (ahora.getMonth() - inicio.getMonth())
  );
  const cicloInicio = new Date(inicio);
  cicloInicio.setMonth(inicio.getMonth() + diffInMonths);

  // 📅 Asegura que la fecha se trunque a YYYY-MM-DD
  const cicloMes = cicloInicio.toISOString().split('T')[0];

  // 📝 Log detallado antes de la inserción
  console.log(`🔄 Intentando insertar/actualizar uso_mensual para tenant: ${tenant.id}, canal: ${canal}, cicloMes: ${cicloMes}`);

  try {
    const result = await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1
      RETURNING *`,
      [tenant.id, canal, cicloMes]
    );

    console.log(`✅ Registro actualizado/insertado en uso_mensual:`, result.rows[0]);
  } catch (error) {
    console.error(`❌ Error al actualizar uso_mensual para tenant ${tenant.id}, canal ${canal}:`, error);
  }

  // Insertar mensaje bot (esto no suma a uso)
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal)
     VALUES ($1, 'assistant', $2, NOW(), $3)`,
    [tenant.id, respuesta, canal]
  );  

  await enviarWhatsApp(fromNumber, respuesta, tenant.id);
  console.log("📬 Respuesta enviada vía Twilio:", respuesta);

  await pool.query(
    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT DO NOTHING`,
    [tenant.id, canal, messageId]
  );  

  try {
    const { intencion, nivel_interes } = await detectarIntencion(userInput);
    const intencionLower = intencion.toLowerCase();
    const textoNormalizado = userInput.trim().toLowerCase();
  
    console.log(`🔎 Intención detectada: ${intencion}, Nivel de interés: ${nivel_interes}`);
  
    // 🛑 No registrar si es saludo
    const saludos = ["hola", "buenas", "buenos días", "buenas tardes", "buenas noches", "hello", "hi", "hey"];
    if (saludos.includes(textoNormalizado)) {
      console.log("⚠️ Mensaje ignorado por ser saludo.");
      return; // Sale del bloque sin guardar nada
    }
  
    // 🔥 Actualiza el segmento a cliente si aplica
    if (["comprar", "compra", "pagar", "agendar", "reservar", "confirmar"].some(p => intencionLower.includes(p))) {
      await pool.query(
        `UPDATE clientes SET segmento = 'cliente' WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`,
        [tenant.id, fromNumber]
      );
    }
  
    // 🔥 Registra en sales_intelligence
    await pool.query(
      `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenant.id, fromNumber, canal, userInput, intencion, nivel_interes, messageId]
    );    
  
    // 🚀 Si nivel_interes >= 4, programa seguimiento
    if (nivel_interes >= 4) {
      const configRes = await pool.query(
        `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
        [tenant.id]
      );
      const config = configRes.rows[0];
  
      if (config) {
        let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
  
        // Personaliza según intención
        if (intencionLower.includes("precio") && config.mensaje_precio) {
          mensajeSeguimiento = config.mensaje_precio;
        } else if ((intencionLower.includes("agendar") || intencionLower.includes("reservar")) && config.mensaje_agendar) {
          mensajeSeguimiento = config.mensaje_agendar;
        } else if ((intencionLower.includes("ubicacion") || intencionLower.includes("location")) && config.mensaje_ubicacion) {
          mensajeSeguimiento = config.mensaje_ubicacion;
        }
  
        try {
          const idiomaMensaje = await detectarIdioma(mensajeSeguimiento);
          if (idiomaMensaje !== idioma) {
            mensajeSeguimiento = await traducirMensaje(mensajeSeguimiento, idioma);
          }
        } catch {}

        const fechaEnvio = new Date();
        fechaEnvio.setMinutes(fechaEnvio.getMinutes() + (config.minutos_espera || 5));
  
        // Elimina duplicados
        await pool.query(
          `DELETE FROM mensajes_programados
           WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
          [tenant.id, canal, fromNumber]
        );
  
        // Inserta nuevo mensaje programado
        await pool.query(
          `INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
           VALUES ($1, $2, $3, $4, $5, false)`,
          [tenant.id, canal, fromNumber, mensajeSeguimiento, fechaEnvio]
        );
  
        console.log(`✅ Seguimiento programado para ${fromNumber} con: "${mensajeSeguimiento}"`);
      }
    }
  } catch (err) {
    console.error("⚠️ Error en inteligencia de ventas o seguimiento:", err);
  }  
}  
