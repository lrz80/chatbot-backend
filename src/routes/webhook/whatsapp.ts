// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { buildDudaSlug, isDirectIntent, normalizeIntentAlias } from '../../lib/intentSlug';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido } from '../../lib/respuestasTraducidas';
import { enviarWhatsApp } from '../../lib/senders/whatsapp';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { runBeginnerRecoInterceptor } from '../../lib/recoPrincipiantes/interceptor';
import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';
import { buscarRespuestaPorIntencion } from "../../services/intent-matcher";
import { extractEntitiesLite } from '../../utils/extractEntitiesLite';

const PRICE_REGEX = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
const MATCHER_MIN_OVERRIDE = 0.85; // exige score alto para sobreescribir una intención "directa"

const INTENT_THRESHOLD = Math.min(
  0.95,
  Math.max(0.30, Number(process.env.INTENT_MATCH_THRESHOLD ?? 0.55))
);

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const INTENTS_DIRECT = new Set([
  'interes_clases','precio','horario','ubicacion','reservar','comprar','confirmar',
  'clases_online' // 👈 añade esto
]);

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
  let respuesta: any = getBienvenidaPorCanal('whatsapp', tenant, idioma);
  const canal = 'whatsapp';

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

  const mensajeUsuario = normalizarTexto(userInput);

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

  // después de calcular idiomaDestino...
  let INTENCION_FINAL_CANONICA = '';

  // 3️⃣ Detectar intención
  const { intencion: intencionDetectada } = await detectarIntencion(mensajeUsuario, tenant.id, 'whatsapp');
  const intencionLower = intencionDetectada?.trim().toLowerCase() || "";
  console.log(`🧠 Intención detectada al inicio para tenant ${tenant.id}: "${intencionLower}"`);

  let intencionProc = intencionLower; // se actualizará tras traducir (si aplica)
  let intencionParaFaq = intencionLower; // esta será la que usemos para consultar FAQ

  // 4️⃣ Si es saludo/agradecimiento, solo sal si el mensaje es SOLO eso
  const greetingOnly = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|dias|días))?|buenas|buenos\s+(dias|días))\s*$/i
  .test(userInput.trim());
  const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i.test(userInput.trim());

  if ((intencionLower === "saludo" && greetingOnly) || (intencionLower === "agradecimiento" && thanksOnly)) {
    const respuestaRapida =
      intencionLower === "agradecimiento"
        ? "¡De nada! 💬 ¿Quieres ver otra opción del menú?"
        : await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

    await enviarWhatsApp(fromNumber, respuestaRapida, tenant.id);
    return;
  }

  if (["hola", "buenas", "hello", "hi", "hey"].includes(mensajeUsuario)) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino); // antes: idioma
  }else {
  
    // Paso 1: Detectar idioma y traducir para evaluar intención
    const textoTraducido = idiomaDestino !== 'es'
      ? await traducirMensaje(userInput, 'es')
      : userInput;

    // ✅ NUEVO: quitar saludos al inicio para no sesgar la intención
    const textoParaIntent = stripLeadGreetings(textoTraducido);

    const { intencion: intencionProcesada } =
      await detectarIntencion(textoParaIntent, tenant.id, 'whatsapp');

    intencionProc = (intencionProcesada || '').trim().toLowerCase();
    intencionParaFaq = intencionProc;
    console.log(`🧠 Intención detectada (procesada): "${intencionProc}"`);

    // [ADD] Si la intención es "duda", refinamos a un sub-slug tipo "duda__duracion_clase"
    if (intencionProc === 'duda') {
      const refined = buildDudaSlug(userInput);
      console.log(`🎯 Refino duda → ${refined}`);
      intencionProc = refined;
      intencionParaFaq = refined; // este es el que usas para consultar FAQ
    }

    // 🔹 Canonicaliza alias (virtuales → online, etc.)
    intencionProc = normalizeIntentAlias(intencionProc);
    intencionParaFaq = normalizeIntentAlias(intencionParaFaq);

    INTENCION_FINAL_CANONICA = (intencionParaFaq || intencionProc || '').trim().toLowerCase();
    console.log(`🎯 Intención final (canónica) = ${INTENCION_FINAL_CANONICA}`);

    // 👉 Detección de temporalidad/especificidad (sin DB) + fallbacks
    const cleanedForTime = stripLeadGreetings(userInput);

    // 1) Intenta con extractor “lite”
    const entsEarly = extractEntitiesLite(cleanedForTime);

    try {
    } catch (e) {
      console.warn('⚠️ Rama específica falló; continuará pipeline normal:', e);
    }

// ─── INTENCIONES (matcher) — RESPONDE ANTES DE FAQs/IA ───────────────────────
try {
  // Comparamos en ES (igual que FAQs). Si el cliente no habla ES, traducimos su mensaje a ES.
  const textoParaMatch = (idiomaDestino !== 'es')
    ? await traducirMensaje(userInput, 'es').catch(() => userInput)
    : userInput;

  console.log('[INTENTS] match input=', textoParaMatch);

  const respIntent = await buscarRespuestaPorIntencion({
    tenant_id: tenant.id,
    canal: 'whatsapp',              // este webhook es WhatsApp
    mensajeUsuario: textoParaMatch,
    idiomaDetectado: idiomaDestino, // 'es' | 'en'
    umbral: Math.max(INTENT_THRESHOLD, 0.70),
    filtrarPorIdioma: true
  });

  console.log('[INTENTS] result=', respIntent);

  // --- Anti-mismatch entre intención canónica y matcher (segundo bloque) ---
  const canonical = (INTENCION_FINAL_CANONICA || '').toLowerCase();
  const respIntentName = (respIntent?.intent || '').toLowerCase();

  // Intenciones "fuertes" (directas)
  const isCanonicalDirect = isDirectIntent(canonical, INTENTS_DIRECT);

  // ¿El usuario pidió explícitamente precio?
  const askedPrice = PRICE_REGEX.test(userInput);

  // 1) Nunca aceptes 'precio' si NO lo pidió y la canónica es distinta
  if (respIntent && respIntentName === 'precio' && !askedPrice && canonical && canonical !== 'precio') {
    console.log('[GUARD-2] bloqueo precio: no fue solicitado y la canónica=', canonical, 'score=', respIntent?.score);
    // @ts-ignore
    respIntent.intent = null;
    // @ts-ignore
    respIntent.respuesta = null;
  }

  // 2) Si la canónica es DIRECTA y difiere del matcher, exige score alto (>= 0.85)
  if (respIntent && isCanonicalDirect && respIntentName && respIntentName !== canonical) {
    const score = Number(respIntent?.score ?? 0);
    if (score < MATCHER_MIN_OVERRIDE) {
      console.log('[GUARD-2] canónica directa vs matcher (score bajo). Mantengo canónica:', { canonical, respIntentName, score });
      // @ts-ignore
      respIntent.intent = null;
      // @ts-ignore
      respIntent.respuesta = null;
    }
  }

  if (respIntent?.respuesta) {
  let facts = respIntent.respuesta;

  // (Opcional) añade un breve resumen si el user pidió “info + precios”
  const askedInfo = /\b(info(?:rmación)?|clases?|servicios?)\b/i.test(userInput);
  const askedPrice = PRICE_REGEX.test(userInput);
  if (askedInfo && askedPrice) {
    try {
      const { rows } = await pool.query(
        `SELECT respuesta FROM faqs
         WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) IN ('interes_clases','info_general','servicios')
         ORDER BY 1 LIMIT 1`,
        [tenant.id, canal]
      );
      const extra = rows[0]?.respuesta?.trim();
      if (extra) facts = `${extra}\n\n${facts}`;
    } catch {}
  }

  // 🔸 Siempre pasa por LLM con tu promptBase para “salir del prompt”
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
  const systemPrompt = [
    promptBase,
    '',
    'Tienes HECHOS verificables del negocio. Responde corto, cálido y claro.',
    'No inventes datos fuera de HECHOS. Si hay links, inclúyelos una vez.',
  ].join('\n');

  const userPrompt = [
    `MENSAJE_USUARIO:\n${userInput}`,
    '',
    `HECHOS (usa sólo esto como fuente):\n${facts}`,
    '',
    `IDIOMA_SALIDA: ${idiomaDestino}`
  ].join('\n');

  let out = facts; // fallback mínimo si el LLM falla
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    out = completion.choices[0]?.message?.content?.trim() || out;
  } catch (e) {
    console.warn('LLM compose falló; uso facts crudos:', e);
  }

  // Asegura idioma
  try {
    const langOut = await detectarIdioma(out);
    if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
      out = await traducirMensaje(out, idiomaDestino);
    }
  } catch {}

  await enviarWhatsApp(fromNumber, out, tenant.id);

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
    [tenant.id, canal, messageId]
  );

  // follow-up igual que antes
  try {
    let intFinal = (respIntent.intent || '').toLowerCase().trim();
    if (intFinal === 'duda') intFinal = buildDudaSlug(userInput);
    intFinal = normalizeIntentAlias(intFinal);
    const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    const nivel = det?.nivel_interes ?? 1;
    await scheduleFollowUp(intFinal, nivel);
  } catch (e) {
    console.warn('⚠️ No se pudo programar follow-up post-intent (WA):', e);
  }

  return; // <- ahora sí sales, pero después de “pasar por el prompt”
}

} catch (e) {
  console.warn('⚠️ Matcher de intenciones no coincidió o falló:', e);
}

// 🔎 Interceptor canal-agnóstico (recomendación principiantes)
const interceptado = await runBeginnerRecoInterceptor({
  tenantId: tenant.id,
  canal: 'whatsapp',
  fromNumber,
  userInput,
  idiomaDestino,
  intencionParaFaq,
  promptBase,
  enviarFn: enviarWhatsApp, // tu sender chunker
});

if (interceptado) {
  // ya respondió + registró sugerida + (opcional) follow-up se maneja afuera si quieres
  // Si quieres mantener tu follow-up actual aquí, puedes dejarlo después de este if.
  console.log('✅ Interceptor principiantes respondió en WhatsApp.');

  try {
    let intFinal = (intencionParaFaq || '').toLowerCase().trim();
    if (!intFinal) {
      const detTmp = await detectarIntencion(userInput, tenant.id, 'whatsapp');
      intFinal = normalizeIntentAlias((detTmp?.intencion || '').toLowerCase());
    }
    const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    const nivel = det?.nivel_interes ?? 1;
    await scheduleFollowUp(intFinal, nivel);
  } catch (e) {
    console.warn('⚠️ No se pudo programar follow-up tras interceptor (WA):', e);
  }  
  return; // evita FAQ genérica
}

  // [REPLACE] lookup robusto
  let respuestaDesdeFaq: string | null = null;

  if (isDirectIntent(intencionParaFaq, INTENTS_DIRECT)) {
    if (intencionParaFaq === 'precio') {
      // 🔎 Usa helper robusto para precios (alias + sub-slugs)
      respuestaDesdeFaq = await fetchFaqPrecio(tenant.id, canal);
      if (respuestaDesdeFaq) {
        console.log('📚 FAQ precio (robusta) encontrada.');
      }
    } else {
      // Camino normal para otras intenciones directas
      const { rows: faqPorIntencion } = await pool.query(
        `SELECT respuesta FROM faqs 
        WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = LOWER($3) LIMIT 1`,
        [tenant.id, canal, intencionParaFaq]
      );
      if (faqPorIntencion.length > 0) {
        respuestaDesdeFaq = faqPorIntencion[0].respuesta;
      }
    }
  }

  if (respuestaDesdeFaq) {
  // 1) Construye los HECHOS desde la FAQ oficial
  let facts = respuestaDesdeFaq;

  // 2) Pásalo por OpenAI con tu promptBase (igual que en la rama de intents)
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const systemPrompt = [
    promptBase,
    '',
    `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
    'Formato WhatsApp: máx. 6 líneas, claro y con bullets si hace falta.',
    'Usa únicamente los HECHOS; no inventes.',
    'Si hay ENLACES_OFICIALES en los hechos, comparte solo 1 (el más pertinente) tal cual.'
  ].join('\n');

  const userPrompt = [
    `MENSAJE_USUARIO:\n${userInput}`,
    '',
    `HECHOS (fuente autorizada):\n${facts}`
  ].join('\n');

  let out = facts; // fallback si el LLM falla
  let tokens = 0;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
    });
    out = completion.choices[0]?.message?.content?.trim() || out;
    tokens = completion.usage?.total_tokens || 0;
  } catch (e) {
    console.warn('LLM compose (FAQ) falló; envío facts crudos:', e);
  }

  // 3) Asegura idioma de salida
  try {
    const langOut = await detectarIdioma(out);
    if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
      out = await traducirMensaje(out, idiomaDestino);
    }
  } catch {}

  // 4) Enviar y registrar (igual que siempre)
  await enviarWhatsApp(fromNumber, out, tenant.id);

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
    [tenant.id, canal, messageId]
  );

  if (tokens > 0) {
    await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
       VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
       ON CONFLICT (tenant_id, canal, mes)
       DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
      [tenant.id, tokens]
    );
  }

  // ⚙️ Mantén tu bloque de inteligencia/follow-up tal cual, luego RETURN
  try {
    const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    const nivelFaq = det?.nivel_interes ?? 1;
    const intFinal = (INTENCION_FINAL_CANONICA || '').toLowerCase();

    const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
    if (nivelFaq >= 3 || intencionesFollowUp.includes(intFinal)) {
      await scheduleFollowUp(intFinal, nivelFaq);
    }
  } catch (e) {
    console.warn('⚠️ No se pudo programar follow-up tras FAQ (WA):', e);
  }

  return; // 🔚 importante para no caer a los bloques de abajo
}

// Si NO hubo FAQ directa → similaridad
{
  const mensajeTraducido = (idiomaDestino !== 'es')
    ? await traducirMensaje(mensajeUsuario, 'es')
    : mensajeUsuario;

  respuesta = await buscarRespuestaSimilitudFaqsTraducido(
    faqs,
    mensajeTraducido,
    idiomaDestino
  );
}

// 🔒 Protección adicional: si ya respondió con FAQ oficial, no continuar
if (respuestaDesdeFaq) {
  console.log("🔒 Ya se respondió con una FAQ oficial. Se cancela generación de sugerida.");
  return;
}

// ⛔ No generes sugeridas si el mensaje NO tiene letras (p.ej. "8") o es muy corto
const hasLetters = /\p{L}/u.test(userInput);
if (!hasLetters || normalizarTexto(userInput).length < 4) {
  console.log('🧯 No se genera sugerida (sin letras o texto muy corto).');
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

    let intencionFinal = intencionDetectadaParaGuardar.trim().toLowerCase();
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

  await enviarWhatsApp(fromNumber, respuesta, tenant.id);
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
} 
