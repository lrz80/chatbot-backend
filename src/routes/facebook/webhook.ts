// src/routes/facebook/webhook.ts

import express from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buildDudaSlug, normalizeIntentAlias, isDirectIntent } from '../../lib/intentSlug';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { runBeginnerRecoInterceptor } from '../../lib/recoPrincipiantes/interceptor';
import { buscarRespuestaPorIntencion } from '../../services/intent-matcher';
import { enviarMensajePorPartes } from '../../lib/enviarMensajePorPartes';
import { extractEntitiesLite } from '../../utils/extractEntitiesLite';
import { getFaqByIntent } from '../../utils/getFaqByIntent';
import { answerMultiIntent, detectTopIntents } from '../../utils/multiIntent';
import { tidyMultiAnswer } from '../../utils/tidyMultiAnswer';
import { Router, Request, Response } from 'express';
import { buscarRespuestaSimilitudFaqsTraducido } from '../../lib/respuestasTraducidas';
import type { Canal } from '../../lib/detectarIntencion';
import { requireChannel } from "../../middleware/requireChannel";
import { canUseChannel } from "../../lib/features";
import { antiPhishingGuard } from "../../lib/security/antiPhishing";

type CanalEnvio = 'facebook' | 'instagram';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

const GLOBAL_ID = process.env.GLOBAL_CHANNEL_TENANT_ID
  || '00000000-0000-0000-0000-000000000001'; // fallback seguro
// ———————————————————————————————————————————————————————————
// Config comunes (idénticos a WhatsApp)
// ———————————————————————————————————————————————————————————
const PRICE_REGEX = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
const MATCHER_MIN_OVERRIDE = 0.85;

const INTENT_THRESHOLD = Math.min(
  0.95,
  Math.max(0.30, Number(process.env.INTENT_MATCH_THRESHOLD ?? 0.55))
);

const INTENTS_DIRECT = new Set([
  'interes_clases','precio','horario','ubicacion','reservar','comprar','confirmar','clases_online'
]);

const INTENT_UNIQUE = new Set([
  'precio','horario','ubicacion','reservar','comprar','confirmar','interes_clases','clases_online'
]);

// Normalizadores de idioma
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base;
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';

function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  return Number.isFinite(m) && m > 0 ? m : fallbackMin;
}

// Idioma persistente por contacto
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
      DO UPDATE SET idioma = EXCLUDED.idioma, updated_at = now()`,
      [tenantId, contacto, idioma]
    );
  } catch (e) {
    console.warn('No se pudo guardar idioma del cliente:', e);
  }
}

// Ciclo mensual similar a WA
function cicloMesDesdeMembresia(membresiaInicioISO: string): string {
  const inicio = new Date(membresiaInicioISO);
  const ahora = new Date();
  const diffMes = Math.floor(
    (ahora.getFullYear() - inicio.getFullYear()) * 12 +
    (ahora.getMonth() - inicio.getMonth())
  );
  const cicloInicio = new Date(inicio);
  cicloInicio.setMonth(inicio.getMonth() + diffMes);
  return cicloInicio.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function isMetaChannelOpen(tenantId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT meta_enabled, paused_until_meta
       FROM channel_settings
      WHERE tenant_id = $1 OR tenant_id = $2
      ORDER BY CASE WHEN tenant_id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [tenantId, GLOBAL_ID]
  );
  const row = rows[0];
  if (!row) return true;                   // sin fila => abierto por defecto
  const enabled = row.meta_enabled !== false; // null/true => abierto
  const paused = row.paused_until_meta
    ? new Date(row.paused_until_meta).getTime() > Date.now()
    : false;
  return enabled && !paused;
}

// Evita loops por duplicados Meta mid
const mensajesProcesados = new Set<string>();

// ———————————————————————————————————————————————————————————
// Verificación GET (Meta)
// ———————————————————————————————————————————————————————————
router.get('/api/facebook/webhook', requireChannel("meta"), (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'testtoken';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook de Facebook verificado');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ———————————————————————————————————————————————————————————
// POST: Meta (Facebook / Instagram) — igual a WhatsApp en flujo
// ———————————————————————————————————————————————————————————
router.post('/api/facebook/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') return;

    for (const entry of body.entry) {
      const pageId = entry.id;

      for (const messagingEvent of entry.messaging) {
        if (!messagingEvent.message) continue;
        if (messagingEvent.message.is_echo === true) continue;
        if (!messagingEvent.message.text) continue;

        const senderId = messagingEvent.sender.id;
        const messageId = messagingEvent.message.mid;
        const userInput = messagingEvent.message.text || '';
        const isNumericOnly = /^\s*\d+\s*$/.test(userInput);

        // dedupe por mid (memoria)
        if (mensajesProcesados.has(messageId)) continue;
        mensajesProcesados.add(messageId);
        setTimeout(() => mensajesProcesados.delete(messageId), 60000);

        // Unir tenants + meta-configs (id x pageId o ig id)
        const { rows } = await pool.query(
          `SELECT t.*
                 , m.prompt_meta
                 , m.bienvenida_meta
                 , t.facebook_access_token
            FROM tenants t
       LEFT JOIN meta_configs m ON t.id = m.tenant_id
           WHERE t.facebook_page_id = $1 OR t.instagram_page_id = $1
           LIMIT 1`,
          [pageId]
        );
        if (!rows.length) continue;

        const tenant = rows[0];
        const tenantId: string = tenant.id;

        const isInstagram = tenant.instagram_page_id && tenant.instagram_page_id === pageId;
        const canalEnvio: CanalEnvio = isInstagram ? 'instagram' : 'facebook';
        const canalContenido = 'meta'; // FAQs se guardan como 'meta'
        const accessToken = tenant.facebook_access_token as string;


        // 🚧 Gate unificado por plan/pausa/mantenimiento
        try {
          const gate = await canUseChannel(tenantId, "meta");
          if (!gate.plan_enabled) {
            console.log("🛑 META bloqueado por plan; no se responderá.", { tenantId });
            continue; // no respondas nada (ya hiciste 200 arriba)
          }
          if (gate.reason === "paused") {
            console.log("⏸️ META en pausa hasta", gate.paused_until, "; no se responderá.");
            continue;
          }
        } catch (e) {
          console.warn("Guard META: error calculando canUseChannel; bloqueo por seguridad:", e);
          continue;
        }

        // helper envío Meta (chunked)
        const sendMeta = async (text: string) => {
          await enviarMensajePorPartes({
            respuesta: text,
            senderId,
            tenantId,
            canal: canalEnvio,
            messageId,
            accessToken,
          });
        };
        const enviarMetaSeguro = async (_to: string, text: string, _tenantId: string) => sendMeta(text);

        // Idempotencia: si ya está en messages, avanzar
        const existingMsg = await pool.query(
          `SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
          [tenantId, messageId]
        );
        if (existingMsg.rows.length > 0) continue;

        // 🌐 Idioma destino (mismo que WA) — MOVER AQUÍ
        const tenantBase: 'es'|'en' = normalizeLang(tenant?.idioma || 'es');
        let idiomaDestino: 'es'|'en';
        if (isNumericOnly) {
          idiomaDestino = await getIdiomaClienteDB(tenantId, senderId, tenantBase);
        } else {
          let detectado: string | null = null;
          try { detectado = normLang(await detectarIdioma(userInput)); } catch {}
          const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
          await upsertIdiomaClienteDB(tenantId, senderId, normalizado);
          idiomaDestino = normalizado;
        }

        // 🛡️ Anti-phishing reutilizable (EARLY EXIT)
        const handledPhishing = await antiPhishingGuard({
          pool,
          tenantId,
          channel: canalEnvio,   // "facebook" o "instagram"
          senderId,
          messageId,
          userInput,
          idiomaDestino,         // ✅ ahora sí lo pasamos
          send: async (text) => sendMeta(text),
        });
        if (handledPhishing) {
          // Ya se respondió y registró; NO sigas con FAQs/IA/etc.
          continue;
        }

        // 🧹 Cancela follow-ups pendientes de este contacto
        try {
          await pool.query(
            `DELETE FROM mensajes_programados
              WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
            [tenantId, canalEnvio, senderId]
          );
        } catch {}

        // Incrementar uso mensual por mensaje entrante (como WA)
        try {
          const tRes = await pool.query(`SELECT membresia_inicio FROM tenants WHERE id = $1`, [tenantId]);
          const membresiaInicio = tRes.rows[0]?.membresia_inicio;
          if (membresiaInicio) {
            const cicloMes = cicloMesDesdeMembresia(membresiaInicio);
            await pool.query(
              `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
               VALUES ($1, $2, $3, 1)
               ON CONFLICT (tenant_id, canal, mes)
               DO UPDATE SET usados = uso_mensual.usados + 1`,
              [tenantId, canalEnvio, cicloMes]
            );
          }
        } catch {}

        // Guardar mensaje user (una vez)
        try {
          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, userInput, canalEnvio, senderId || 'anónimo', messageId]
          );
        } catch {}

        // Bloqueo por membresía (igual WA)
        const estaActiva = tenant.membresia_activa === true || tenant.membresia_activa === 'true' || tenant.membresia_activa === 1;
        if (!estaActiva) {
          console.log(`🚫 Tenant ${tenantId} sin membresía activa. No se responderá en Meta.`);
          continue;
        }

        // Prompt base y bienvenida por CANAL
        const promptBase = getPromptPorCanal('meta', tenant, idiomaDestino);
        const bienvenida = getBienvenidaPorCanal('meta', tenant, idiomaDestino);

        // —————————————————————————
        // FAST-PATH MULTI-INTENCIÓN
        // —————————————————————————
        try {
          const top = await detectTopIntents(userInput, tenantId, canalContenido as any, 3);
          const hasPrecio = top.some(t => t.intent === 'precio');
          const hasInfo   = top.some(t => t.intent === 'interes_clases' || t.intent === 'pedir_info');
          const multiAsk  = top.length >= 2 || (hasPrecio && hasInfo);

          if (multiAsk) {
            const multi = await answerMultiIntent({
              tenantId,
              canal: canalContenido as any,
              userText: userInput,
              idiomaDestino,
              promptBase
            });

            if (multi?.text) {
              const out = tidyMultiAnswer(multi.text, {
                maxLines: 6,
                freezeUrls: true,
                cta: '¿Hay algo más en lo que te pueda ayudar?'
              });

              await sendMeta(out);

              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                 VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
                 ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
              );
              await pool.query(
                `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT DO NOTHING`,
                [tenantId, canalEnvio, messageId]
              );

              await scheduleFollowUp('interes_clases', 3);
              continue; // ⬅️ salir fast-path
            }
          }
        } catch (e) {
          console.warn('⚠️ Multi-intent fast-path falló; sigo pipeline normal:', e);
        }

       // Follow-up scheduler + registro de intención (canónica)
      async function scheduleFollowUp(intFinal: string, nivel: number) {
        try {
          // 👇 Forzamos canónico aquí
          const canon = normalizeIntentAlias((intFinal || '').toLowerCase().trim()) || '';
          // fallback específico para precios si tu normalizador no lo convierte
          const canonFinal = PRICE_REGEX.test(canon) || PRICE_REGEX.test(intFinal) ? 'precio' : canon;
          if (!canonFinal) return;

          await pool.query(
            `INSERT INTO sales_intelligence
              (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
            [tenantId, senderId, canalEnvio, userInput, canonFinal, Math.max(1, Number(nivel)||1), messageId]
          );
          console.log('🧠 Intent registrada (META)', {
            tenantId, contacto: senderId, canal: canalEnvio, intencion: canonFinal, nivel
          });

          const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
          const condition = (nivel >= 3) || intencionesFollowUp.includes(canonFinal);
          if (!condition) return;

          const { rows: cfgRows } = await pool.query(
            `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
            [tenantId]
          );
          const cfg = cfgRows[0];
          if (!cfg) return;

          // Mensaje por defecto + variantes por intención
          let msg = cfg.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
          if (canon === "precio" && cfg.mensaje_precio) msg = cfg.mensaje_precio;
          else if ((canon === "reservar" || canon === "comprar") && cfg.mensaje_agendar) msg = cfg.mensaje_agendar;
          else if (canon === "ubicacion" && cfg.mensaje_ubicacion) msg = cfg.mensaje_ubicacion;

          // Asegura idioma de salida consistente
          try {
            const lang = await detectarIdioma(msg);
            if (lang && lang !== 'zxx' && lang !== idiomaDestino) {
              msg = await traducirMensaje(msg, idiomaDestino);
            }
          } catch {}

          // 4) Limpia duplicados pendientes para este contacto
          await pool.query(
            `DELETE FROM mensajes_programados
              WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
            [tenantId, canalEnvio, senderId]
          );

          // 5) Programa el follow-up
          const delayMin = getConfigDelayMinutes(cfg, 60);
          const fechaEnvio = new Date();
          fechaEnvio.setMinutes(fechaEnvio.getMinutes() + delayMin);

          const { rows } = await pool.query(
            `INSERT INTO mensajes_programados
              (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
            VALUES ($1, $2, $3, $4, $5, false)
            RETURNING id`,
            [tenantId, canalEnvio, senderId, msg, fechaEnvio]
          );

          console.log('📅 Follow-up programado (META)', {
            id: rows[0]?.id, tenantId, contacto: senderId, delayMin, fechaEnvio: fechaEnvio.toISOString()
          });
        } catch (e) {
          console.warn('⚠️ No se pudo programar follow-up o registrar intención (META):', e);
        }
      }

        // Saludos/agradecimientos (solo si el mensaje ES solo eso)
        const greetingOnly = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|d[ií]as))?)\s*$/i.test(userInput.trim());
        const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i.test(userInput.trim());
        if (greetingOnly || thanksOnly) {
          let out = thanksOnly
            ? (idiomaDestino === 'es'
                ? '¡De nada! 💬 ¿Quieres ver otra opción del menú?'
                : "You're welcome! 💬 Would you like to see other options?")
            : bienvenida;

          try {
            const langOut = await detectarIdioma(out);
            if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
              out = await traducirMensaje(out, idiomaDestino);
            }
          } catch {}
          await sendMeta(out);

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
          );
          continue;
        }

        // Cargar FAQs del canal meta
        let faqs: any[] = [];
        try {
          const resFaqs = await pool.query(
            `SELECT pregunta, respuesta
               FROM faqs
              WHERE tenant_id = $1
                AND canal = ANY($2::text[])`,
            [tenantId, ['meta','facebook','instagram']]
          );
          faqs = resFaqs.rows || [];
        } catch {}
    
        // INTENT MATCHER (con guards)
        try {
          const idiomaDet: 'es'|'en' = normalizeLang(normLang(await detectarIdioma(userInput)) || tenantBase);
          const textoParaMatch = (idiomaDet === 'es') ? userInput : await traducirMensaje(userInput, 'es');

          const respIntent = await buscarRespuestaPorIntencion({
            tenant_id: tenantId,
            canal: 'meta',
            mensajeUsuario: textoParaMatch,
            idiomaDetectado: idiomaDet,
            umbral: Math.max(INTENT_THRESHOLD, 0.70),
            filtrarPorIdioma: true
          });

          // Canonical detect (rápido) para aplicar guards
          const { intencion: intenTemp } = await detectarIntencion(userInput, tenantId, canalEnvio);
          const canonical = normalizeIntentAlias((intenTemp || '').toLowerCase());
          const isCanonicalDirect = isDirectIntent(canonical, INTENTS_DIRECT);
          const respIntentName = (respIntent?.intent || '').toLowerCase();
          const askedPrice = PRICE_REGEX.test(userInput);

          // Guard 1: no “precio” si no lo pidió y la canónica difiere
          if (respIntent && respIntentName === 'precio' && !askedPrice && canonical && canonical !== 'precio') {
            // @ts-ignore
            respIntent.intent = null;
            // @ts-ignore
            respIntent.respuesta = null;
          }
          // Guard 2: si canónica es DIRECTA y difiere, exige score alto
          if (respIntent && isCanonicalDirect && respIntentName && respIntentName !== canonical) {
            const score = Number(respIntent?.score ?? 0);
            if (score < MATCHER_MIN_OVERRIDE) {
              // @ts-ignore
              respIntent.intent = null;
              // @ts-ignore
              respIntent.respuesta = null;
            }
          }

          if (respIntent?.respuesta) {
            // Pasar por LLM con promptBase (igual WA)
            const systemPrompt = [
              promptBase,
              '',
              `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
              'Formato Meta: máx. ~6 líneas en PROSA. Sin Markdown, sin bullets.',
              'Usa únicamente los HECHOS; no inventes.',
              'Si hay ENLACES_OFICIALES en los hechos/prompt, comparte solo 1 (el más pertinente) tal cual.'
            ].join('\n');

            let facts = respIntent.respuesta;
            const askedInfo = /\b(info(?:rmación)?|clases?|servicios?)\b/i.test(userInput);
            if (askedInfo && askedPrice) {
              try {
                const { rows } = await pool.query(
                  `SELECT respuesta FROM faqs
                    WHERE tenant_id = $1
                      AND canal = ANY($2::text[])
                      AND LOWER(intencion) IN ('interes_clases','info_general','servicios')
                    ORDER BY 1 LIMIT 1`,
                  [tenantId, ['meta','facebook','instagram']]
                );
                const extra = rows[0]?.respuesta?.trim();
                if (extra) facts = `${extra}\n\n${facts}`;
              } catch {}
            }

            const userPrompt = [
              `MENSAJE_USUARIO:\n${userInput}`,
              '',
              `HECHOS (usa sólo esto como fuente):\n${facts}`,
              '',
              `IDIOMA_SALIDA: ${idiomaDestino}`
            ].join('\n');

            let out = facts;
            try {
              const completion = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                temperature: 0.2,
                max_tokens: 400,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt },
                ],
              });
              const used = completion.usage?.total_tokens || 0;
              if (used > 0) {
                await pool.query(
                  `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                   VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                   ON CONFLICT (tenant_id, canal, mes)
                   DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                  [tenantId, used]
                );
              }
              out = completion.choices[0]?.message?.content?.trim() || out;
            } catch (e) {
              console.warn('LLM compose falló; uso facts crudos:', e);
            }

            try {
              const langOut = await detectarIdioma(out);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                out = await traducirMensaje(out, idiomaDestino);
              }
            } catch {}

            await sendMeta(out);
            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
               VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
               ON CONFLICT (tenant_id, message_id) DO NOTHING`,
              [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
            );
            await pool.query(
              `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT DO NOTHING`,
              [tenantId, canalEnvio, messageId]
            );

            try {
              const det = await detectarIntencion(userInput, tenantId, canalEnvio);
              const nivel = det?.nivel_interes ?? 1;
              let intFinal = (respIntent.intent || '').toLowerCase().trim();
              if (intFinal === 'duda') intFinal = buildDudaSlug(userInput);
              intFinal = normalizeIntentAlias(intFinal);
              await scheduleFollowUp(intFinal, nivel);
            } catch {}

            continue; // ✅ ya respondió por intención
          }
        } catch (e) {
          console.warn('⚠️ Matcher de intenciones no coincidió o falló:', e);
        }

        // Interceptor de principiantes (canal-agnóstico)
        let intencionParaFaq = '';
        try {
          const textoES = (idiomaDestino === 'es') ? userInput : await traducirMensaje(userInput, 'es');
          const det0 = await detectarIntencion(textoES, tenantId, canalEnvio);
          let proc = (det0?.intencion || '').trim().toLowerCase();
          if (proc === 'duda') proc = buildDudaSlug(userInput);
          proc = normalizeIntentAlias(proc);

          if (PRICE_REGEX.test(userInput)) proc = 'precio';
          else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) proc = 'clases_online';

          intencionParaFaq = proc;
        } catch {}

        const interceptado = await runBeginnerRecoInterceptor({
          tenantId,
          canal: canalEnvio,
          fromNumber: senderId,
          userInput,
          idiomaDestino,
          intencionParaFaq,
          promptBase,
          enviarFn: enviarMetaSeguro,
        });

        if (interceptado) {
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );
          // follow-up post interceptor (opcional)
          try {
            const det = await detectarIntencion(userInput, tenantId, canalEnvio);
            await scheduleFollowUp(intencionParaFaq || normalizeIntentAlias(det?.intencion || ''), det?.nivel_interes ?? 1);
          } catch {}
          continue;
        }

        // FAQ directa por intención (global, igual a WA)
        try {
          let intentFAQ = (intencionParaFaq || '').trim().toLowerCase();
          if (!intentFAQ) {
            const textoES = (idiomaDestino === 'es') ? userInput : await traducirMensaje(userInput, 'es');
            const det1 = await detectarIntencion(textoES, tenantId, canalEnvio);
            let proc = (det1?.intencion || '').trim().toLowerCase();
            if (proc === 'duda') proc = buildDudaSlug(userInput);
            proc = normalizeIntentAlias(proc);
            if (PRICE_REGEX.test(userInput)) proc = 'precio';
            else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) proc = 'clases_online';
            intentFAQ = proc;
          }

          if (isDirectIntent(intentFAQ, INTENTS_DIRECT)) {
            let respuestaDesdeFaq: string | null = null;
            if (intentFAQ === 'precio') {
              respuestaDesdeFaq = await fetchFaqPrecio(tenantId, canalContenido);
            } else {
              const hit = await getFaqByIntent(tenantId, canalContenido as any, intentFAQ);
              respuestaDesdeFaq = hit?.respuesta || null;
            }

            if (respuestaDesdeFaq) {
              // Pasar por LLM con promptBase (igual WA/intent branch de arriba)
              const systemPrompt = [
                promptBase,
                '',
                `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
                'Formato Meta: máx. ~6 líneas, claro, sin bullets.',
                'Usa SOLO la información del prompt/HECHOS.',
                'Si hay ENLACES_OFICIALES, comparte solo 1 (el más pertinente).'
              ].join('\n');

              const userPrompt = [
                `MENSAJE_USUARIO:\n${userInput}`,
                '',
                `HECHOS (fuente autorizada):\n${respuestaDesdeFaq}`
              ].join('\n');

              let out = respuestaDesdeFaq;
              try {
                const completion = await openai.chat.completions.create({
                  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                  temperature: 0.2,
                  max_tokens: 400,
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt }
                  ],
                });
                const used = completion.usage?.total_tokens || 0;
                if (used > 0) {
                  await pool.query(
                    `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                     VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                     ON CONFLICT (tenant_id, canal, mes)
                     DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                    [tenantId, used]
                  );
                }
                out = completion.choices[0]?.message?.content?.trim() || out;
              } catch (e) {
                console.warn('LLM compose (FAQ) falló; envío facts crudos:', e);
              }

              try {
                const langOut = await detectarIdioma(out);
                if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                  out = await traducirMensaje(out, idiomaDestino);
                }
              } catch {}

              await sendMeta(out);
              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                 VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
                 ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
              );
              await pool.query(
                `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT DO NOTHING`,
                [tenantId, canalEnvio, messageId]
              );

              // follow-up si aplica
              try {
                const det = await detectarIntencion(userInput, tenantId, canalEnvio);
                const nivel = det?.nivel_interes ?? 1;
                await scheduleFollowUp(intentFAQ, nivel);
              } catch {}

              continue; // ⛔️ no sigas a similitud/LLM genérico
            }
          }
        } catch (e) {
          console.warn('⚠️ FAQ directa global falló:', e);
        }

        // —————————————————————————
        // Similaridad + LLM fallback (sugeridas)
        // —————————————————————————
        let respuesta: string | null = null;

        // Similaridad sobre FAQs traducidas (reutiliza helper existente si lo prefieres)
        // Aquí haremos un fallback directo a LLM con promptBase si no hubo nada antes:
        if (!respuesta) {
          try {
            const systemPrompt = [
              promptBase,
              '',
              `Reglas:
              - Usa EXCLUSIVAMENTE la info del prompt. Si falta algo, dilo sin inventar.
              - Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.
              - Meta: máx. ~6 líneas en PROSA. Sin Markdown/viñetas.
              - Si el usuario hace varias preguntas, respóndelas TODAS en un solo mensaje.
              - CTA único (si aplica). Enlaces: solo si están en ENLACES_OFICIALES.`
            ].join('\n');

            const userPrompt = `MENSAJE_USUARIO:\n${userInput}\n\nResponde usando solo los datos del prompt.`;

            const completion = await openai.chat.completions.create({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              temperature: 0.2,
              max_tokens: 400,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
              ],
            });

            const used = completion.usage?.total_tokens ?? 0;
            if (used > 0) {
              await pool.query(
                `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                 VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                 ON CONFLICT (tenant_id, canal, mes)
                 DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                [tenantId, used]
              );
            }

            respuesta = completion.choices[0]?.message?.content?.trim()
                      || bienvenida;

            // Asegura idioma
            try {
              const langOut = await detectarIdioma(respuesta);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                respuesta = await traducirMensaje(respuesta, idiomaDestino);
              }
            } catch {}

            // Registrar FAQ sugerida (con reglas de unicidad como WA)
            const hasLetters = /\p{L}/u.test(userInput);
            if (hasLetters && normalizarTexto(userInput).length >= 4) {
              const preguntaNormalizada = normalizarTexto(userInput);
              const respuestaNormalizada = (respuesta || '').trim();

              let sugeridasExistentes: any[] = [];
              try {
                const sugRes = await pool.query(
                  'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
                  [tenantId, canalContenido]
                );
                sugeridasExistentes = sugRes.rows || [];
              } catch {}

              const yaExisteSug = yaExisteComoFaqSugerida(userInput, respuesta || '', sugeridasExistentes);
              const yaExisteAprob = yaExisteComoFaqAprobada(userInput, respuesta || '', faqs);

              if (!yaExisteSug && !yaExisteAprob) {
                const textoESparaGuardar = (idiomaDestino === 'es') ? userInput : await traducirMensaje(userInput, 'es');
                const detGuardar = await detectarIntencion(textoESparaGuardar, tenantId, canalEnvio);
                let intencionFinal = (detGuardar?.intencion || '').trim().toLowerCase();
                if (intencionFinal === 'duda') intencionFinal = buildDudaSlug(userInput);
                intencionFinal = normalizeIntentAlias(intencionFinal);

                if (PRICE_REGEX.test(userInput)) intencionFinal = 'precio';
                else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) intencionFinal = 'clases_online';

                if (INTENT_UNIQUE.has(intencionFinal)) {
                  const { rows: faqsOficiales } = await pool.query(
                    `SELECT 1
                       FROM faqs
                      WHERE tenant_id = $1
                        AND canal = ANY($2::text[])
                        AND LOWER(intencion) = LOWER($3)
                      LIMIT 1`,
                    [tenantId, ['meta','facebook','instagram'], intencionFinal]
                  );
                  if (!faqsOficiales.length) {
                    const { rows: sugConInt } = await pool.query(
                      `SELECT 1 FROM faq_sugeridas
                        WHERE tenant_id = $1 AND canal = $2 AND procesada = false
                          AND LOWER(intencion) = LOWER($3)
                        LIMIT 1`,
                      [tenantId, canalContenido, intencionFinal]
                    );
                    if (!sugConInt.length) {
                      await pool.query(
                        `INSERT INTO faq_sugeridas
                          (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                        VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                        [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idiomaDestino, intencionFinal]
                      );
                    }
                  }
                } else {
                  await pool.query(
                    `INSERT INTO faq_sugeridas
                      (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                    VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                    [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idiomaDestino, intencionFinal]
                  );
                }
              } else if (yaExisteSug) {
                await pool.query(
                  `UPDATE faq_sugeridas
                     SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
                   WHERE id = $1`,
                  [yaExisteSug.id]
                );
              }
            }
          } catch (e) {
            console.warn('❌ EARLY_RETURN Meta falló:', e);
          }
        }

        // Enviar salida final si llegamos aquí
        const outFinal = respuesta || bienvenida;
        try {
          await sendMeta(outFinal);
          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, outFinal, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
          );
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );
        } catch (err: any) {
          console.error('❌ Error enviando a Meta:', err?.response?.data || err.message || err);
        }

        // Inteligencia de ventas + follow-up final (idéntico a WA)
        try {
          const det = await detectarIntencion(userInput, tenantId, canalEnvio);
          const nivel_interes = det?.nivel_interes ?? 1;
          let intFinal = normalizeIntentAlias((det?.intencion || '').toLowerCase());

          if (intFinal === 'duda') intFinal = buildDudaSlug(userInput);
          if (PRICE_REGEX.test(userInput)) intFinal = 'precio';
          else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) intFinal = 'clases_online';

          // Segmentación básica
          const intencionesCliente = ["comprar","compra","pagar","agendar","reservar","confirmar","interes_clases","precio"];
          if (intencionesCliente.some(p => intFinal.includes(p))) {
            await pool.query(
              `UPDATE clientes
                  SET segmento = 'cliente'
               WHERE tenant_id = $1 AND contacto = $2
                 AND (segmento = 'lead' OR segmento IS NULL)`,
              [tenantId, senderId]
            );
          }

          await scheduleFollowUp(intFinal, nivel_interes);
        } catch (e) {
          console.warn('⚠️ Error en inteligencia de ventas o seguimiento:', e);
        }
      }
    }
  } catch (error: any) {
    console.error('❌ Error en webhook Meta:', error?.response?.data || error.message || error);
  }
});

export default router;
