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
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';
import { detectarIntencion } from '../../lib/detectarIntencion';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const enviarWhatsAppSeguro = async (to: string, text: string, tenantId: string) => {
  const MAX = 1500; // margen
  for (let i = 0; i < text.length; i += MAX) {
    await enviarWhatsApp(to, text.slice(i, i + MAX), tenantId);
  }
};


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
    flows = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];

  } catch {}

  let faqs: any[] = [];
  try {
    const faqsRes = await pool.query(
      'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND canal = $2',
      [tenant.id, canal]
    );    
    faqs = faqsRes.rows || [];
  } catch (err) {
    console.error("❌ Error cargando FAQs:", err);
    faqs = [];
  }  

  const mensajeUsuario = normalizarTexto(userInput);

  // Detectar idioma del cliente
  let idiomaCliente = 'es'; // idioma por defecto
  try {
    idiomaCliente = await detectarIdioma(mensajeUsuario);
  } catch (err) {
    console.warn("⚠️ No se pudo detectar idioma del cliente, usando 'es'", err);
  }

  let respuestaDesdeFaq: string | null = null;
  if (["hola", "buenas", "hello", "hi", "hey"].includes(mensajeUsuario)) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idioma);
  } else {
  // Paso 1: Detectar idioma y traducir para evaluar intención
  const textoTraducido = idiomaCliente !== 'es'
    ? await traducirMensaje(userInput, 'es')
    : userInput;

  const { intencion: intencionDetectada } = await detectarIntencion(textoTraducido);
  const intencion = intencionDetectada.trim().toLowerCase();
  console.log(`🧠 Intención detectada (procesada): "${intencion}"`);

  if (intencion === 'pedir_info' && flows.length > 0 && flows[0].opciones?.length > 0) {
    const pregunta = flows[0]?.pregunta || flows[0]?.mensaje || '¿Cómo puedo ayudarte?';
    const opciones = flows[0].opciones.map((op: any, i: number) =>
      `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`).join('\n');
  
    const menu = `💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
  
    await enviarWhatsAppSeguro(fromNumber, menu, tenant.id);
    console.log("📬 Menú enviado desde Flujos Guiados Interactivos.");
    return;
  }  

  const nrm = (t: string) =>
    (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  
  const nUser = nrm(mensajeUsuario);

  const saludoCorto = ["hola","buenas","hello","hi","hey"];
  // Solo considerar saludo si el mensaje ENTERO es un saludo corto
  if (saludoCorto.includes(mensajeUsuario)) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idioma);
  }
  
  // ✅ Detector robusto para “pedir info”, cubre “inf”, “mas info”, etc.
  const esPedirInfo =
    /\bmas\s*info\b/.test(nUser) ||         // "mas info" / "más info" (ya normalizado)
    /\binfo\b/.test(nUser) ||               // contiene "info"
    /\binf\b/.test(nUser) ||                // SOLO "inf"
    /\bquiero\s+mas\b/.test(nUser) ||       // "quiero mas ..."
    nUser.endsWith(' inf') ||               // termina en " inf"
    nUser.includes('quiero informacion') ||
    nUser.includes('mas informacion');

  // 🧠 Flujos guiados (si mensaje es "quiero info", "más información", etc.)
const mensajeLower = mensajeUsuario.toLowerCase();
const keywordsInfo = [
  'quiero informacion',
  'más información',
  'mas informacion',
  'info',
  'necesito informacion',
  'deseo informacion',
  'quiero saber',
  'me puedes decir',
  'quiero saber mas',
  'i want info',
  'i want information',
  'more info',
  'more information',
  'tell me more',
  'inf'
];

if (esPedirInfo || keywordsInfo.some(k => nUser.includes(nrm(k)))) {
  const flow = flows[0];
if (flow?.opciones?.length > 0) {
  const pregunta = flow.pregunta || flow.mensaje || '¿Cómo puedo ayudarte?';
  const opciones = flow.opciones
    .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
    .join('\n');

  let menu = `💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;

  // 🌐 Si el usuario no está en español, traducimos TODO el menú
  if (idiomaCliente && idiomaCliente !== 'es') {
    try {
      menu = await traducirMensaje(menu, idiomaCliente);
    } catch (e) {
      console.warn('No se pudo traducir el menú, se enviará en ES:', e);
    }
  }

  await enviarWhatsApp(fromNumber, menu, tenant.id);
  console.log("📬 Menú personalizado enviado desde Flujos Guiados Interactivos.");
  return;
  }
}

// ✅ Detectar si eligió una opción del menú (responde con "1", "2", etc.)
if (/^[1-9]$/.test(mensajeUsuario) && Array.isArray(flows[0]?.opciones) && flows[0].opciones.length) {
  const opcionIndex = parseInt(mensajeUsuario, 10) - 1;
  const opcionesNivel1 = flows[0].opciones;

  // índice fuera de rango → ignorar
  if (opcionIndex < 0 || opcionIndex >= opcionesNivel1.length) {
    console.log("⚠️ Opción fuera de rango, se continúa con el flujo normal.");
  } else {
    const opcionSeleccionada = opcionesNivel1[opcionIndex];

    // 1) Caso respuesta directa
    if (opcionSeleccionada?.respuesta) {
      let out = opcionSeleccionada.respuesta;
      try {
        const idiomaOut = await detectarIdioma(out);
        if (idiomaOut !== idiomaCliente) {
          out = await traducirMensaje(out, idiomaCliente);
        }
      } catch (e) {
        console.warn('No se pudo traducir la respuesta de la opción:', e);
      }

      await enviarWhatsAppSeguro(fromNumber, out, tenant.id);
      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal)
         VALUES ($1, 'assistant', $2, NOW(), $3)`,
        [tenant.id, out, canal]
      );
      console.log("📬 Respuesta enviada desde opción seleccionada del menú");
      return;
    }

    // 2) Caso SUBMENÚ: construir y enviar submenú
    if (opcionSeleccionada?.submenu?.opciones?.length) {
      const titulo = opcionSeleccionada.submenu.mensaje || 'Elige una opción:';
      const opcionesSub = opcionSeleccionada.submenu.opciones
        .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
        .join('\n');

      let menuSub = `💡 ${titulo}\n${opcionesSub}\n\n` +
                    `👉 Responde con el *texto* de la opción (ej: "Facial").`;

      try {
        if (idiomaCliente && idiomaCliente !== 'es') {
          menuSub = await traducirMensaje(menuSub, idiomaCliente);
        }
      } catch (e) {
        console.warn('No se pudo traducir el submenú, se enviará en ES:', e);
      }

      await enviarWhatsAppSeguro(fromNumber, menuSub, tenant.id);
      console.log("📬 Submenú enviado.");
      return;
    }

    // 3) Si no hay respuesta ni submenú, continúa al flujo normal/FAQ
    console.log("ℹ️ Opción sin respuesta ni submenú; continúa el flujo.");
  }
}

  // Paso 2: Buscar primero una FAQ oficial por intención exacta y canal
  const { rows: faqPorIntencion } = await pool.query(
    `SELECT respuesta FROM faqs 
     WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = LOWER($3) LIMIT 1`,
    [tenant.id, canal, intencion]
  );  

  respuestaDesdeFaq = null;

  if (faqPorIntencion.length > 0) {
    respuestaDesdeFaq = faqPorIntencion[0].respuesta;
    respuesta = respuestaDesdeFaq;
    console.log(`✅ Respuesta tomada desde FAQ oficial por intención: "${intencion}"`);
    console.log("📚 FAQ utilizada:", respuestaDesdeFaq);
  
    // Si la respuesta de la FAQ no está en el idioma del cliente, traducirla
    const idiomaRespuesta = await detectarIdioma(respuesta);
    if (idiomaRespuesta !== idiomaCliente) {
      console.log(`🌐 Traduciendo respuesta desde ${idiomaRespuesta} a ${idiomaCliente}`);
      respuesta = await traducirMensaje(respuesta, idiomaCliente);
    } else {
      console.log(`✅ No se traduce. Respuesta ya en idioma ${idiomaCliente}`);
    }
  
    const messageId = body.MessageSid || body.SmsMessageSid || null;
  
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'user', $2, NOW(), $3, $4, $5)`,
      [tenant.id, userInput, canal, fromNumber || "anónimo", messageId]
    );
  
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal)
       VALUES ($1, 'assistant', $2, NOW(), $3)`,
      [tenant.id, respuesta, canal]
    );  
  
    await enviarWhatsAppSeguro(fromNumber, respuesta, tenant.id);
    console.log("📬 Respuesta enviada vía Twilio (desde FAQ oficial):", respuesta);
  
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );
  
    return; // 🛑 Detiene ejecución: ya respondió con la FAQ oficial
  }else {
    // Paso 3: Buscar por similitud en FAQs sin intención definida
    const mensajeTraducido = idiomaCliente !== 'es'
  ? await traducirMensaje(mensajeUsuario, 'es')
  : mensajeUsuario;

respuesta = await buscarRespuestaSimilitudFaqsTraducido(faqs, mensajeTraducido, idiomaCliente)
      || await buscarRespuestaDesdeFlowsTraducido(flows, mensajeTraducido, idiomaCliente);

  }
}

// 🔒 Protección adicional: si ya respondió con FAQ oficial, no continuar
if (respuestaDesdeFaq) {
  console.log("🔒 Ya se respondió con una FAQ oficial. Se cancela generación de sugerida.");
  return;
}

// 🧠 Si no hay respuesta aún, generar con OpenAI y registrar como FAQ sugerida
if (!respuestaDesdeFaq && !respuesta) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const completion = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      { role: 'system', content: promptBase },
      { role: 'user', content: userInput },
    ],
  });

  respuesta = completion.choices[0]?.message?.content?.trim()
           || getBienvenidaPorCanal('whatsapp', tenant, idioma);

  // 🌐 Asegurar idioma del cliente
  try {
    const idiomaRespuesta = await detectarIdioma(respuesta);
    if (idiomaRespuesta !== idiomaCliente) {
      respuesta = await traducirMensaje(respuesta, idiomaCliente);
    }
  } catch (e) {
    console.warn('No se pudo traducir la respuesta de OpenAI:', e);
  }

  respuesta = completion.choices[0]?.message?.content?.trim() || getBienvenidaPorCanal('whatsapp', tenant, idioma);
  const respuestaGenerada = respuesta;

  const respuestaGeneradaLimpia = respuesta;
  const preguntaNormalizada = normalizarTexto(userInput);
  const respuestaNormalizada = respuestaGeneradaLimpia.trim();

  let sugeridasExistentes: any[] = [];
  try {
    const sugeridasRes = await pool.query(
      'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
      [tenant.id, canal]
    );
    sugeridasExistentes = sugeridasRes.rows || [];
  } catch (error) {
    console.error('⚠️ Error consultando FAQ sugeridas:', error);
  }

  // Verificación de duplicados
  const yaExisteSugerida = yaExisteComoFaqSugerida(
    userInput,
    respuestaGenerada,
    sugeridasExistentes
  );

  const yaExisteAprobada = yaExisteComoFaqAprobada(
    userInput,
    respuestaGenerada,
    faqs
  );

  if (yaExisteSugerida || yaExisteAprobada) {
    if (yaExisteSugerida) {
      await pool.query(
        `UPDATE faq_sugeridas 
         SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
         WHERE id = $1`,
        [yaExisteSugerida.id]
      );
      console.log(`⚠️ Pregunta similar ya sugerida (ID: ${yaExisteSugerida.id})`);
    } else {
      console.log(`⚠️ Pregunta ya registrada como FAQ oficial.`);
    }
  } else {
    // 🧠 Detectar intención para evitar duplicados semánticos
    const textoTraducidoParaGuardar = idioma !== 'es'
    ? await traducirMensaje(userInput, 'es')
    : userInput;

    const { intencion: intencionDetectadaParaGuardar } = await detectarIntencion(textoTraducidoParaGuardar);
    const intencionFinal = intencionDetectadaParaGuardar.trim().toLowerCase();

    const { rows: sugeridasConIntencion } = await pool.query(
    `SELECT intencion FROM faq_sugeridas 
    WHERE tenant_id = $1 AND canal = $2 AND procesada = false`,
    [tenant.id, canal]
    );

    const { rows: faqsOficiales } = await pool.query(
    `SELECT intencion FROM faqs 
    WHERE tenant_id = $1 AND canal = $2`,
    [tenant.id, canal]
    );

    // 🧠 Compara intención detectada con las oficiales
    const yaExisteIntencionOficial = faqsOficiales.some(faq =>
    faq.intencion?.trim().toLowerCase() === intencionFinal
    );

    if (yaExisteIntencionOficial) {
    console.log(`⚠️ Ya existe una FAQ oficial con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
    return;
    }

    const yaExisteIntencion = sugeridasConIntencion.some(faq =>
    faq.intencion?.trim().toLowerCase() === intencionFinal
    );

    if (yaExisteIntencion) {
    console.log(`⚠️ Ya existe una FAQ sugerida con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
    } else {
    // ✅ Insertar la sugerencia
    await pool.query(
      `INSERT INTO faq_sugeridas (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
      VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
      [tenant.id, canal, preguntaNormalizada, respuestaNormalizada, idioma, intencionFinal]
    );

    console.log(`📝 Pregunta no resuelta registrada: "${preguntaNormalizada}"`);
    }

  }

    const tokensConsumidos = completion.usage?.total_tokens || 0;
    if (tokensConsumidos > 0) {
      await pool.query(
        `UPDATE uso_mensual SET usados = usados + $1 WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`,
        [tokensConsumidos, tenant.id]
      );
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

  await enviarWhatsAppSeguro(fromNumber, respuesta, tenant.id);
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
