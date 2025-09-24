// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { buildDudaSlug, normalizeIntentAlias } from '../../lib/intentSlug';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { enviarWhatsApp } from '../../lib/senders/whatsapp';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';
import { detectarIntencion } from '../../lib/detectarIntencion';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

// Intenciones que deben ser únicas por tenant/canal
const INTENT_UNIQUE = new Set([
  'precio','horario','ubicacion','reservar','comprar','confirmar','interes_clases','clases_online'
]);

// Normalizadores
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base; // zxx = sin lenguaje
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';


function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  if (Number.isFinite(m) && m > 0) return m;
  return fallbackMin;
}

// Acceso a DB para idioma del contacto
async function getIdiomaClienteDB(tenantId: string, contacto: string, fallback: 'es'|'en'): Promise<'es'|'en'> {
  try {
    const { rows } = await pool.query(
      `SELECT idioma FROM clientes WHERE tenant_id = $1 AND contacto = $2 LIMIT 1`,
      [tenantId, contacto]
    );
    if (rows[0]?.idioma) return normalizeLang(rows[0].idioma);
  } catch {}
  return fallback;
}

async function upsertIdiomaClienteDB(tenantId: string, contacto: string, idioma: 'es'|'en') {
  try {
    await pool.query(
      `INSERT INTO clientes (tenant_id, contacto, idioma)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, contacto)
       DO UPDATE SET idioma = EXCLUDED.idioma`,
      [tenantId, contacto, idioma]
    );
  } catch (e) {
    console.warn('No se pudo guardar idioma del cliente:', e);
  }
}

router.post('/', async (req: Request, res: Response) => {
  console.log("📩 Webhook recibido:", req.body);

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
  const messageId = body.MessageSid || body.SmsMessageSid || null;

  const tenantRes = await pool.query('SELECT * FROM tenants WHERE twilio_number = $1 LIMIT 1', [numero]);
  const tenant = tenantRes.rows[0];
  if (!tenant) return;

  // 🚫 No responder si la membresía está inactiva
  if (!tenant.membresia_activa) {
    console.log(`⛔ Membresía inactiva para tenant ${tenant.name || tenant.id}. No se responderá.`);
    return;
  }

  // 2.a) Guardar el mensaje del usuario una sola vez (idempotente)
try {
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
     VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
     ON CONFLICT (tenant_id, message_id) DO NOTHING`,
    [tenant.id, userInput, 'whatsapp', fromNumber || 'anónimo', messageId]
  );
} catch (e) {
  console.warn('No se pudo registrar mensaje user:', e);
}

// 2.b) Incrementar uso mensual (antes de cualquier return)
try {
  const { rows: rowsTenant } = await pool.query(
    `SELECT membresia_inicio FROM tenants WHERE id = $1`, [tenant.id]
  );
  const membresiaInicio = rowsTenant[0]?.membresia_inicio;
  if (membresiaInicio) {
    const inicio = new Date(membresiaInicio);
    const ahora = new Date();
    const diffInMonths = Math.floor((ahora.getFullYear() - inicio.getFullYear()) * 12 + (ahora.getMonth() - inicio.getMonth()));
    const cicloInicio = new Date(inicio); cicloInicio.setMonth(inicio.getMonth() + diffInMonths);
    const cicloMes = cicloInicio.toISOString().split('T')[0];

    await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1`,
      [tenant.id, 'whatsapp', cicloMes]
    );
  }
} catch (e) {
  console.error('❌ Error incrementando uso_mensual:', e);
}

  const idioma = await detectarIdioma(userInput);
  const promptBase = getPromptPorCanal('whatsapp', tenant, idioma);
  let respuesta = '';
  const canal = 'whatsapp';

// 👇 PÉGALO AQUÍ (debajo de getLink)
function stripLeadGreetings(t: string) {
  return t
    .replace(/^\s*(hola+[\s!.,]*)?/i, '')
    .replace(/^\s*(saludos+[\s!.,]*)?/i, '')
    .replace(/^\s*(hello+|hi+|hey+)[\s!.,]*/i, '')
    .trim();
}

  // 🧹 Cancela cualquier follow-up pendiente para este contacto al recibir nuevo mensaje
  try {
      await pool.query(
        `DELETE FROM mensajes_programados
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
        [tenant.id, canal, fromNumber]
      );
      console.log('🧽 Follow-ups pendientes limpiados (WA):', { tenantId: tenant.id, fromNumber });
    } catch (e) {
      console.warn('No se pudieron limpiar follow-ups pendientes:', e);
    }

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

  // 1️⃣ Detectar si es solo número
  const isNumericOnly = /^\s*\d+\s*$/.test(userInput);

  // 2️⃣ Calcular idiomaDestino
  const tenantBase: 'es'|'en' = normalizeLang(tenant?.idioma || 'es');
  let idiomaDestino: 'es'|'en';

  if (isNumericOnly) {
    idiomaDestino = await getIdiomaClienteDB(tenant.id, fromNumber, tenantBase);
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
  } else {
    let detectado: string | null = null;
    try { detectado = normLang(await detectarIdioma(userInput)); } catch {}
    const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
    await upsertIdiomaClienteDB(tenant.id, fromNumber, normalizado);
    idiomaDestino = normalizado;
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= userInput`);
  }


  // ⏲️ Programador de follow-up (WhatsApp)
  async function scheduleFollowUp(intFinal: string, nivel: number) {
    try {
      const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
      const condition = (nivel >= 3) || intencionesFollowUp.includes((intFinal || '').toLowerCase());
      console.log('⏩ followup gate (WA)', { intFinal, nivel, condition });
      if (!condition) return;

      // Config tenant
      const { rows: cfgRows } = await pool.query(
        `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
        [tenant.id]
      );
      const cfg = cfgRows[0];
      if (!cfg) {
        console.log('⚠️ Sin follow_up_settings; no se programa follow-up.');
        return;
      }

      // Selección del mensaje por intención
      let msg = cfg.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
      const low = (intFinal || '').toLowerCase();
      if (low.includes("precio") && cfg.mensaje_precio) {
        msg = cfg.mensaje_precio;
      } else if ((low.includes("agendar") || low.includes("reservar")) && cfg.mensaje_agendar) {
        msg = cfg.mensaje_agendar;
      } else if ((low.includes("ubicacion") || low.includes("location")) && cfg.mensaje_ubicacion) {
        msg = cfg.mensaje_ubicacion;
      }

      // Asegura idioma del cliente
      try {
        const lang = await detectarIdioma(msg);
        if (lang && lang !== 'zxx' && lang !== idiomaDestino) {
          msg = await traducirMensaje(msg, idiomaDestino);
        }
      } catch {}

      // Evita duplicados: borra pendientes no enviados
      await pool.query(
        `DELETE FROM mensajes_programados
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
        [tenant.id, 'whatsapp', fromNumber]
      );

      const delayMin = getConfigDelayMinutes(cfg, 60);
      const fechaEnvio = new Date();
      fechaEnvio.setMinutes(fechaEnvio.getMinutes() + delayMin);

      const { rows } = await pool.query(
        `INSERT INTO mensajes_programados
          (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
        VALUES ($1, $2, $3, $4, $5, false)
        RETURNING id`,
        [tenant.id, 'whatsapp', fromNumber, msg, fechaEnvio]
      );

      console.log('📅 Follow-up programado (WA)', {
        id: rows[0]?.id,
        tenantId: tenant.id,
        contacto: fromNumber,
        delayMin,
        fechaEnvio: fechaEnvio.toISOString(),
      });
    } catch (e) {
      console.warn('⚠️ No se pudo programar follow-up (WA):', e);
    }
  };

 // 3️⃣ Pipeline simple: INTENCIÓN → FAQ → SIMILITUD → OPENAI
 
 let INTENCION_FINAL_CANONICA = '';
 let respuestaDesdeFaq: string | null = null;

 // a) Detectar intención (canónica)
 try {
   const textoParaIntent = (idiomaDestino !== 'es')
     ? await traducirMensaje(stripLeadGreetings(userInput), 'es').catch(() => userInput)
     : stripLeadGreetings(userInput);
   const det = await detectarIntencion(textoParaIntent, tenant.id, 'whatsapp');
   INTENCION_FINAL_CANONICA = normalizeIntentAlias((det?.intencion || '').trim().toLowerCase());

   // --- Override ligero por temporalidad (tolerante a acentos) ---
  const cleaned = stripLeadGreetings(userInput);

  // Normaliza a lower y quita acentos para matching robusto
  const lower = cleaned.toLowerCase();
  const noAcc = lower.normalize('NFD').replace(/\p{M}/gu, ''); // requiere flag 'u' en los regex si usas \p{M}

  // HH:MM / H:MM con o sin am/pm (acepta 7:30, 7.30, 19:30, 7pm, 7:30pm)
  const timeLikeRe = /(?:\b|^)([01]?\d|2[0-3])([:.]\d{2})?\s*(am|pm)?(?:\b|$)/i;

  // Palabras de tiempo (hoy/mañana/etc) — prueba sobre versión sin acentos
  const dayWordRe  = /(hoy|manana|pasado\s*manana|esta\s*(tarde|noche|manana)|tonight|esta\s*semana|fin\s*de\s*semana)/i;

  // Días de la semana
  const dayNameRe  = /(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)/i;

  // Consulta de disponibilidad/horarios (sin \b, y también sobre noAcc)
  const scheduleHintRe = /(horario|habra|habrá|abren?|clase|clases|schedule|disponible|quedan?|cupos?)/i;

  // Intención de acción (reservar/ir)
  const reserveHintRe  = /(reserv(ar|a|o)|book|apart(ar|o)|quiero\s+ir|asistir|probar|inscribirme)/i;

  const hasTemporal =
    timeLikeRe.test(lower) ||
    dayWordRe.test(noAcc) ||
    dayNameRe.test(noAcc);

  const scheduleHit = scheduleHintRe.test(noAcc);
  const reserveHit  = reserveHintRe.test(noAcc);

  console.log('[Temporal override v2]', { cleaned, hasTemporal, scheduleHit, reserveHit, INTENCION_FINAL_CANONICA });

  // Si no hay intención o es "duda", y hay temporalidad + pista de horario → horario
  if ((!INTENCION_FINAL_CANONICA || INTENCION_FINAL_CANONICA === 'duda') && hasTemporal && scheduleHit) {
    INTENCION_FINAL_CANONICA = 'horario';
    console.log('🎯 Override → horario');
  }

// Si además hay verbo de acción → prioriza reservar
if (hasTemporal && reserveHit) {
  INTENCION_FINAL_CANONICA = 'reservar';
  console.log('🎯 Override → reservar');
}

 } catch (e) {
   console.warn('⚠️ detectarIntencion falló:', e);
   INTENCION_FINAL_CANONICA = '';
 }

 // b) Respuesta por INTENCIÓN (tabla intenciones del tenant)
  try {
    if (INTENCION_FINAL_CANONICA) {
      const { rows } = await pool.query(
        `SELECT respuesta
          FROM intenciones
          WHERE tenant_id = $1
            AND canal = $2
            AND LOWER(nombre) = LOWER($3)
            AND (activo IS TRUE OR activo IS NULL)
          ORDER BY prioridad DESC NULLS LAST, updated_at DESC NULLS LAST
          LIMIT 1`,
        [tenant.id, 'whatsapp', INTENCION_FINAL_CANONICA]
      );

      if (rows[0]?.respuesta) {
        let out = rows[0].respuesta as string;
        try {
          const langOut = await detectarIdioma(out);
          if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
            out = await traducirMensaje(out, idiomaDestino);
          }
        } catch {}
        try { await enviarWhatsApp(fromNumber, out, tenant.id); } catch (e) { console.error('❌ WA (intención):', e); }
        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
          VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
          ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenant.id, out, 'whatsapp', fromNumber || 'anónimo', `${messageId}-bot`]
        );
        await pool.query(
          `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT DO NOTHING`,
          [tenant.id, 'whatsapp', messageId]
        );
        // follow-up
        try {
          const det2 = await detectarIntencion(userInput, tenant.id, 'whatsapp');
          const nivel2 = det2?.nivel_interes ?? 1;
          await scheduleFollowUp(INTENCION_FINAL_CANONICA, nivel2);
        } catch {}
        return;
      }
    }
  } catch (e) {
    console.warn('⚠️ Intent lookup (intenciones) falló:', e);
  }

 // c) FAQ directa por intención (faqs oficiales)
 try {
   if (INTENCION_FINAL_CANONICA) {
     const { rows } = await pool.query(
       `SELECT respuesta FROM faqs
         WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = LOWER($3)
         LIMIT 1`,
       [tenant.id, 'whatsapp', INTENCION_FINAL_CANONICA]
     );
     if (rows[0]?.respuesta) {
       respuestaDesdeFaq = rows[0].respuesta;
     }
   }
 } catch (e) {
   console.warn('⚠️ FAQ por intención falló:', e);
 }

 if (respuestaDesdeFaq) {
   // Traduce si hace falta
   let out = respuestaDesdeFaq;
   try {
     const langOut = await detectarIdioma(out);
     if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
       out = await traducirMensaje(out, idiomaDestino);
     }
   } catch {}
   try {
     await enviarWhatsApp(fromNumber, out, tenant.id);
     } catch (e) {
       console.error('❌ Error enviando WhatsApp (FAQ directa):', e);
     }
   await pool.query(
     `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
        VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
        ON CONFLICT (tenant_id, message_id) DO NOTHING`,
     [tenant.id, out, 'whatsapp', fromNumber || 'anónimo', `${messageId}-bot`]
   );
   await pool.query(
     `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT DO NOTHING`,
     [tenant.id, 'whatsapp', messageId]
   );
   try {
     const det2 = await detectarIntencion(userInput, tenant.id, 'whatsapp');
     const nivel2 = det2?.nivel_interes ?? 1;
     await scheduleFollowUp(INTENCION_FINAL_CANONICA || 'faq', nivel2);
   } catch {}
   return;
 }

// 🧠 Si no hubo FAQ/intención, genera con OpenAI usando el prompt del canal
if (!respuestaDesdeFaq) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: 'system', content: promptBase },
      { role: 'user', content: userInput },
    ],
  });

  respuesta = completion.choices[0]?.message?.content?.trim()
           || getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
           
  const respuestaGenerada = respuesta;

  // 🌐 Asegurar idioma del cliente
  try {
    const idiomaRespuesta = await detectarIdioma(respuesta);
  if (idiomaRespuesta && idiomaRespuesta !== 'zxx' &&
      idiomaRespuesta !== idiomaDestino) {
    respuesta = await traducirMensaje(respuesta, idiomaDestino);
  }

  } catch (e) {
    console.warn('No se pudo traducir la respuesta de OpenAI:', e);
  }

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

    // [REPLACE] Normaliza "duda" a sub-slug antes de guardar la sugerida
    const { intencion: intencionDetectadaParaGuardar } =
    await detectarIntencion(textoTraducidoParaGuardar, tenant.id, 'whatsapp');

    let intencionFinal = (intencionDetectadaParaGuardar || '').trim().toLowerCase();
    if (intencionFinal === 'duda') {
      intencionFinal = buildDudaSlug(userInput);
    }
    intencionFinal = normalizeIntentAlias(intencionFinal); // 👈 CANONICALIZA AQUÍ

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

    // 🧠 Compara intención detectada con las oficiales (aplica unicidad solo a INTENT_UNIQUE)
    const enforzaUnicidad = INTENT_UNIQUE.has(intencionFinal);

    const yaExisteIntencionOficial = faqsOficiales.some(faq =>
      (faq.intencion || '').trim().toLowerCase() === intencionFinal
    );

    if (enforzaUnicidad && yaExisteIntencionOficial) {
      console.log(`⚠️ Ya existe una FAQ oficial con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
    } else {
      const yaExisteIntencion = sugeridasConIntencion.some(faq =>
        (faq.intencion || '').trim().toLowerCase() === intencionFinal
      );

      if (enforzaUnicidad && yaExisteIntencion) {
        console.log(`⚠️ Ya existe una FAQ sugerida con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
        // 🚫 No hacer return aquí
      } else {
        // ✅ Insertar la sugerencia (para intenciones no-únicas como "duda", se permite múltiples)
        await pool.query(
          `INSERT INTO faq_sugeridas (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
          VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
          [tenant.id, canal, preguntaNormalizada, respuestaNormalizada, idioma, intencionFinal]
        );
        console.log(`📝 Pregunta no resuelta registrada: "${preguntaNormalizada}"`);
      }
    }
  }
    const tokensConsumidos = completion.usage?.total_tokens || 0;
    if (tokensConsumidos > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
         VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
         ON CONFLICT (tenant_id, canal, mes)
         DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenant.id, tokensConsumidos]
      );
    }    
  }  

  // Insertar mensaje bot (esto no suma a uso)
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
     VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
     ON CONFLICT (tenant_id, message_id) DO NOTHING`,
    [tenant.id, respuesta, canal, fromNumber || 'anónimo', `${messageId}-bot`]
  );  

  try {
    await enviarWhatsApp(fromNumber, respuesta, tenant.id);
  } catch (e) {
    console.error('❌ Error enviando WhatsApp (fallback OpenAI):', e);
  }
  console.log("📬 Respuesta enviada vía Twilio:", respuesta);

  await pool.query(
    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT DO NOTHING`,
    [tenant.id, canal, messageId]
  );  

  try {
    const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    const nivel_interes = det?.nivel_interes ?? 1;
    const intFinal = (INTENCION_FINAL_CANONICA || '').toLowerCase();
    const textoNormalizado = userInput.trim().toLowerCase();
  
    console.log(`🔎 Intención (final) = ${intFinal}, Nivel de interés: ${nivel_interes}`);
  
    // 🛑 No registrar si es saludo puro
    const saludos = ["hola", "buenas", "buenos días", "buenas tardes", "buenas noches", "hello", "hi", "hey"];
    if (saludos.includes(textoNormalizado)) {
      console.log("⚠️ Mensaje ignorado por ser saludo.");
      return;
    }
  
    // 🔥 Segmentación con intención final
    const intencionesCliente = [
      "comprar", "compra", "pagar", "agendar", "reservar", "confirmar",
      "interes_clases", "precio"
    ];
    if (intencionesCliente.some(p => intFinal.includes(p))) {
      await pool.query(
        `UPDATE clientes
            SET segmento = 'cliente'
          WHERE tenant_id = $1
            AND contacto = $2
            AND (segmento = 'lead' OR segmento IS NULL)`,
        [tenant.id, fromNumber]
      );
    }
  
    // 🔥 Registrar en sales_intelligence con intención final
    await pool.query(
      `INSERT INTO sales_intelligence
        (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
      [tenant.id, fromNumber, canal, userInput, intFinal, nivel_interes, messageId]
    );
  
    // 🚀 Follow-up con intención final
    if (nivel_interes >= 3 || ["interes_clases","reservar","precio","comprar","horario"].includes(intFinal)) {
      await scheduleFollowUp(intFinal, nivel_interes);
    }
    
  } catch (err) {
    console.error("⚠️ Error en inteligencia de ventas o seguimiento:", err);
  }   
} 