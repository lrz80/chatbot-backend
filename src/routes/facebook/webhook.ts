// src/routes/facebook/webhook.ts

import express from 'express';
import pool from '../../lib/db';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaDesdeFlowsTraducido } from '../../lib/respuestasTraducidas';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { enviarMensajePorPartes } from '../../lib/enviarMensajePorPartes';
import OpenAI from 'openai';
import { buildDudaSlug, normalizeIntentAlias, isDirectIntent } from '../../lib/intentSlug';
import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';
import { runBeginnerRecoInterceptor } from '../../lib/recoPrincipiantes/interceptor';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';

// Helpers de idioma (consistentes con WhatsApp)
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base;
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';

const INTENTS_DIRECT = new Set([
  'interes_clases','precio','horario','ubicacion','reservar','comprar','confirmar','clases_online'
]);

const INTENT_UNIQUE = new Set([
  'precio','horario','ubicacion','reservar','comprar','confirmar','interes_clases','clases_online'
]);

// — helpers idioma persistente (como en WhatsApp) —
async function getIdiomaClienteDB(
  tenantId: string,
  contacto: string,
  fallback: 'es'|'en'
): Promise<'es'|'en'> {
  try {
    const { rows } = await pool.query(
      `SELECT idioma FROM clientes WHERE tenant_id = $1 AND contacto = $2 LIMIT 1`,
      [tenantId, contacto]
    );
    if (rows[0]?.idioma) return normalizeLang(rows[0].idioma);
  } catch {}
  return fallback;
}

function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  return Number.isFinite(m) && m > 0 ? m : fallbackMin;
}

async function upsertIdiomaClienteDB(
  tenantId: string,
  contacto: string,
  idioma: 'es'|'en'
) {
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

// Calcula el ciclo mensual vigente a partir de membresia_inicio
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const router = express.Router();

router.get('/api/facebook/webhook', (req, res) => {
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

const mensajesProcesados = new Set<string>();

router.post('/api/facebook/webhook', async (req, res) => {
  res.sendStatus(200);
  console.log("🌐 Webhook Meta recibido:", JSON.stringify(req.body, null, 2));
  try {
    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') return res.sendStatus(404);

    for (const entry of body.entry) {
      const pageId = entry.id;

      for (const messagingEvent of entry.messaging) {
        if (!messagingEvent.message || messagingEvent.message.is_echo || !messagingEvent.message.text) {
          // 🛑 Si es Instagram y el bot se está "autoescuchando"
          if (body.object === 'instagram' && messagingEvent.sender.id === entry.id) {
            console.log('⏭️ Echo de Instagram detectado, ignorado.');
            continue;
          }
  
          console.log('⏭️ Evento ignorado');
          continue;
        }        

        const senderId = messagingEvent.sender.id;
        const messageId = messagingEvent.message.mid;
        const userMessage = messagingEvent.message.text;
        const isNumericOnly = /^\s*\d+\s*$/.test(userMessage);
        // ... (detectas idioma, cargas tenant, calculas canalEnvio/tenantId/accessToken)

        // 📢 Unir tenants + meta-configs
        const { rows } = await pool.query(
          `SELECT t.*, m.prompt_meta, m.bienvenida_meta 
          FROM tenants t
          LEFT JOIN meta_configs m ON t.id = m.tenant_id
          WHERE t.facebook_page_id = $1 OR t.instagram_page_id = $1 LIMIT 1`,
          [pageId]
        );
        if (rows.length === 0) continue;

        const tenant = rows[0];
        const isInstagram = tenant.instagram_page_id && tenant.instagram_page_id === pageId;

        // Canal real para envío/registro/uso
        const canalEnvio: 'facebook' | 'instagram' = isInstagram ? 'instagram' : 'facebook';

        // Canal lógico para contenido (FAQs/Flows compartidos)
        const canalContenido = 'meta';

        const tenantId = tenant.id;
        const accessToken = tenant.facebook_access_token;

        // helper local para enviar a Meta en partes
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

        // 🧹 Cancela cualquier follow-up pendiente para este contacto al recibir nuevo mensaje
        try {
          await pool.query(
            `DELETE FROM mensajes_programados
              WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
            [tenantId, canalEnvio, senderId]
          );
        } catch (e) {
          console.warn('No se pudieron limpiar follow-ups pendientes:', e);
        }

        // Programa follow-up según intención final y nivel de interés
        const scheduleFollowUp = async (intFinal: string, nivel: number) => {
          try {
            // Condición de disparo (idéntica a WhatsApp)
            const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
            if (!(nivel >= 3 || intencionesFollowUp.includes((intFinal || '').toLowerCase()))) return;

            const { rows: cfgRows } = await pool.query(
              `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
              [tenantId]
            );
            const cfg = cfgRows[0];
            if (!cfg) return;

            let msg = cfg.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
            if (intFinal.includes("precio") && cfg.mensaje_precio) {
              msg = cfg.mensaje_precio;
            } else if ((intFinal.includes("agendar") || intFinal.includes("reservar")) && cfg.mensaje_agendar) {
              msg = cfg.mensaje_agendar;
            } else if ((intFinal.includes("ubicacion") || intFinal.includes("location")) && cfg.mensaje_ubicacion) {
              msg = cfg.mensaje_ubicacion;
            }

            try {
              const lang = await detectarIdioma(msg);
              if (lang && lang !== 'zxx' && lang !== idiomaDestino) {
                msg = await traducirMensaje(msg, idiomaDestino);
              }
            } catch {}

            const delayMin = getConfigDelayMinutes(cfg, 60);
            const fechaEnvio = new Date();
            fechaEnvio.setMinutes(fechaEnvio.getMinutes() + delayMin);

            await pool.query(
              `INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
              VALUES ($1, $2, $3, $4, $5, false)`,
              [tenantId, canalEnvio, senderId, msg, fechaEnvio]
            );

            console.log(`📅 Follow-up programado en ${delayMin} min para ${senderId} (${canalEnvio})`);
          } catch (e) {
            console.warn('⚠️ No se pudo programar follow-up:', e);
          }
        };

        // wrapper con firma esperada por el interceptor
        const enviarMetaSeguro = async (_to: string, text: string, _tenantId: string) => {
          await sendMeta(text); // el "to" real ya lo tenemos en senderId
        };

        // 📚 Carga de FAQs y Flows (antes de usarlos)
        let faqs: any[] = [];
        let flows: any[] = [];

        try {
          const resFaqs = await pool.query(
            'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND canal = $2',
            [tenantId, canalContenido] // 'meta'
          );
          faqs = resFaqs.rows || [];
        } catch {}

        const canal = 'meta';

        try {
          const resFlows = await pool.query(
            'SELECT data FROM flows WHERE tenant_id = $1 AND canal = $2 LIMIT 1',
            [tenantId, canal] // canal puede ser 'whatsapp' | 'meta' | 'facebook' | 'instagram'
          );
          const raw = resFlows.rows[0]?.data;
          flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!Array.isArray(flows)) flows = [];
        } catch (error) {
          flows = [];
        }        

        if (mensajesProcesados.has(messageId)) {
          console.log('⚠️ Mensaje duplicado ignorado por Set en memoria:', messageId);
          continue;
        }
        mensajesProcesados.add(messageId);
        setTimeout(() => mensajesProcesados.delete(messageId), 60000); // ⏱️ Bórralo después de 60s
        
        // Detectado del mensaje actual (puede ser útil puntualmente)
        const idioma = await detectarIdioma(userMessage);

        // Idioma base del tenant y destino final a usar en TODAS las respuestas
        const tenantBase: 'es'|'en' = normalizeLang(tenant?.idioma || 'es');
        let idiomaDestino: 'es'|'en';

        if (isNumericOnly) {
          // si el usuario mandó solo un número, usamos lo último que guardamos
          idiomaDestino = await getIdiomaClienteDB(tenantId, senderId, tenantBase);
          console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
        } else {
          // si escribió texto, detectamos y guardamos
          let detectado: string | null = null;
          try { detectado = normLang(await detectarIdioma(userMessage)); } catch {}
          const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
          await upsertIdiomaClienteDB(tenantId, senderId, normalizado);
          idiomaDestino = normalizado;
          console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= userMessage`);
        }

        const existingMsg = await pool.query(
          `SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
          [tenantId, messageId]
        );
        if (existingMsg.rows.length > 0) continue;

        // ✅ Incremento de uso con ciclo vigente y canal real
        const tenantRes = await pool.query(
          'SELECT membresia_inicio FROM tenants WHERE id = $1',
          [tenantId]
        );
        const membresiaInicio = tenantRes.rows[0]?.membresia_inicio;

        if (membresiaInicio) {
          const cicloMes = cicloMesDesdeMembresia(membresiaInicio);
          await pool.query(
            `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1`,
            [tenantId, canalEnvio, cicloMes]
          );
        }

        // 🔒 Chequeo membresía antes de cualquier envío
        const estaActiva =
        tenant.membresia_activa === true ||
        tenant.membresia_activa === 'true' ||
        tenant.membresia_activa === 1;

        if (!estaActiva) {
        console.log(`🚫 Tenant ${tenantId} con membresía inactiva. Solo registramos el mensaje y salimos.`);
        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
          VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
          ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, userMessage, canalEnvio, senderId || 'anónimo', messageId]
        );
        continue; // 👉 no contestes nada en Meta si no está activa
        }

        // 3.4) Saludo / agradecimiento SOLO → respuesta corta y salir
        const greetingOnly = /^\s*(hola|buenas(?:\s+(tardes|noches|d[ií]as))?|hello|hi|hey)\s*$/i.test(userMessage.trim());
        const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i.test(userMessage.trim());

        if (greetingOnly || thanksOnly) {
          // guarda el mensaje del usuario (una sola vez)
          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
            VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
            ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, userMessage, canalEnvio, senderId || 'anónimo', messageId]
          );

          const fallbackBienvenidaES = "Hola, soy Amy, ¿en qué puedo ayudarte hoy?";
          const mensajeBienvenida = (tenant.bienvenida_meta?.trim() || fallbackBienvenidaES);

          let out = thanksOnly
            ? (idioma === 'es'
                ? "¡De nada! 💬 ¿Quieres ver otra opción del menú?"
                : "You're welcome! 💬 Would you like to see other options?")
            : mensajeBienvenida;

          // asegura idioma del cliente
          try {
            const langOut = await detectarIdioma(out);
            if (langOut && langOut !== 'zxx' && langOut !== idioma) {
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

          // no seguimos a similitud/LLM/menú
          continue;
        }

        const nrm = (t: string) =>
          (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        const nUser = nrm(userMessage);
        
        // ✅ Detector robusto para “pedir info”
        const esPedirInfo =
        /\bmas\s*info\b/.test(nUser) ||
        /\binfo\b/.test(nUser) ||
        /\binf\b/.test(nUser) ||
        /\bquiero\s+mas\b/.test(nUser) ||
        nUser.endsWith(' inf') ||
        nUser.includes('quiero informacion') ||
        nUser.includes('mas informacion');

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
        'inf',
        ];

        // 🧠 Flujos guiados (si mensaje es “quiero info”, “más información”, etc.)
        if (esPedirInfo || keywordsInfo.some(k => nUser.includes(nrm(k)))) {
        const flow = flows[0];
        if (flow?.opciones?.length > 0) {
          // 🛑 Verificar estado antes de enviar menú
          const { rows: estadoRows } = await pool.query(
            `SELECT estado FROM clientes WHERE tenant_id = $1 AND contacto = $2 LIMIT 1`,
            [tenantId, senderId]
          );
          const estadoActual = estadoRows[0]?.estado || null;

          if (estadoActual === 'menu_enviado') {
            console.log("⚠️ Menú ya enviado, no se reenviará.");
          } else {
            const pregunta = flow.pregunta || flow.mensaje || '¿Cómo puedo ayudarte?';
            const opciones = flow.opciones
              .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
              .join('\n');

            let menu = `💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;

            if (idiomaDestino !== 'es') {
              try { menu = await traducirMensaje(menu, idiomaDestino); } 
              catch (e) { console.warn('No se pudo traducir el menú, se enviará en ES:', e); }
            }

            await sendMeta(menu);

            // Guarda estado para no reenviar menú hasta que el usuario responda con número
            await pool.query(
              `UPDATE clientes SET estado = 'menu_enviado'
              WHERE tenant_id = $1 AND contacto = $2`,
              [tenantId, senderId]
            );

            console.log("📬 Menú personalizado enviado en Meta.");
          }

          // Cortar el flujo aquí: no pasar a similitud/LLM
          continue;
        }
        }

        // 🛑 Atajo: si el usuario mandó SOLO un número, resolver flujos YA y salir
        if (isNumericOnly && Array.isArray(flows[0]?.opciones) && flows[0].opciones.length) {
          const digitOnlyNum = userMessage.replace(/[^\p{N}]/gu, '').trim();
          const n = Number(digitOnlyNum);
          const opcionesNivel1 = flows[0].opciones;

        // 📝 Guardamos el mensaje del usuario una sola vez aquí
        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
          VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
          ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, userMessage, canalEnvio, senderId || 'anónimo', messageId]
        );

          if (Number.isInteger(n) && n >= 1 && n <= opcionesNivel1.length) {
            const opcionSeleccionada = opcionesNivel1[n - 1];

            // 1) Respuesta directa
            if (opcionSeleccionada?.respuesta) {
              let out = opcionSeleccionada.respuesta;

              try {
                const idiomaOut = await detectarIdioma(out);
                if (idiomaOut && idiomaOut !== 'zxx' && idiomaOut !== idioma) {
                  out = await traducirMensaje(out, idiomaDestino);
                }
              } catch {}

              // 📌 Recordatorio de menú
              out += "\n\n💡 ¿Quieres ver otra opción del menú? Responde con el número correspondiente.";

              await sendMeta(out);

              // Guarda el mensaje asistente (canal real)
              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
                ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
              );

              // ⛔ Importante: no sigas con similitud/LLM
              continue;
            }

            // 3.5) Intención → canonizar → FAQ directa (atajo) y salir
            try {
              // Detecta intención en ES (si el usuario no escribió en ES, traducimos SOLO para detectar)
              const textoES = (idioma === 'es') ? userMessage : await traducirMensaje(userMessage, 'es');

              const det = await detectarIntencion(textoES, tenantId, canalEnvio);
              let intencionProc = (det?.intencion || '').trim().toLowerCase();
              let intencionParaFaq = intencionProc;

              // Si es "duda" → sub-slug (ej: duda__duracion_clase)
              if (intencionProc === 'duda') {
                const refined = buildDudaSlug(userMessage);
                intencionProc = refined;
                intencionParaFaq = refined;
              }

              // Canonicaliza alias (virtuales→online, etc.)
              intencionProc = normalizeIntentAlias(intencionProc);
              intencionParaFaq = normalizeIntentAlias(intencionParaFaq);

              // Overrides por keywords
              const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
              if (priceRegex.test(userMessage)) {
                intencionProc = 'precio';
                intencionParaFaq = 'precio';
              } else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) {
                intencionProc = 'clases_online';
                intencionParaFaq = 'clases_online';
              }

              if (isDirectIntent(intencionParaFaq, INTENTS_DIRECT)) {
                // 1) Buscar FAQ directa por intención (precio usa helper especial)
                let respuestaDesdeFaq: string | null = null;

                if (intencionParaFaq === 'precio') {
                  respuestaDesdeFaq = await fetchFaqPrecio(tenantId, canalContenido); // 'meta'
                } else {
                  const { rows: faqPorIntencion } = await pool.query(
                    `SELECT respuesta FROM faqs
                    WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = LOWER($3)
                    LIMIT 1`,
                    [tenantId, canalContenido, intencionParaFaq]
                  );
                  respuestaDesdeFaq = faqPorIntencion[0]?.respuesta || null;
                }

                if (respuestaDesdeFaq) {
                  // Asegura idioma del cliente
                  let out = respuestaDesdeFaq;
                  try {
                    const langOut = await detectarIdioma(out);
                    if (langOut && langOut !== 'zxx' && langOut !== idioma) {
                      out = await traducirMensaje(out, idiomaDestino);
                    }
                  } catch {}

                  // Guarda mensaje del usuario (una vez)
                  await pool.query(
                    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                    VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
                    ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                    [tenantId, userMessage, canalEnvio, senderId || 'anónimo', messageId]
                  );

                  // Envía y guarda respuesta
                  await sendMeta(out);
                  await pool.query(
                    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                    VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
                    ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                    [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
                  );

                  // Interaction (opcional)
                  await pool.query(
                    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT DO NOTHING`,
                    [tenantId, canalEnvio, messageId]
                  );

                  try {
                    const det = await detectarIntencion(userMessage, tenantId, canalEnvio);
                    const nivel = det?.nivel_interes ?? 1;
                    const intFinal = (intencionParaFaq || '').toLowerCase();
                  
                    // Segmentación como en WhatsApp
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
                  
                    await scheduleFollowUp(intFinal, nivel);
                  } catch {}
                  
                  continue;
                }
              }
            } catch (e) {
              console.warn('⚠️ Fallback: no se pudo resolver FAQ directa por intención:', e);
            }

            // 1.5) Submenú terminal (solo mensaje)
            if (opcionSeleccionada?.submenu && !opcionSeleccionada?.submenu?.opciones?.length) {
              let out = opcionSeleccionada.submenu.mensaje || '';
              if (out) {
                try {
                  const idiomaOut = await detectarIdioma(out);
                  if (idiomaOut && idiomaOut !== 'zxx' && idiomaOut !== idioma) {
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

                // ⬇️ aquí reseteas el estado
                await pool.query(
                  `UPDATE clientes SET estado = 'fuera_menu'
                  WHERE tenant_id = $1 AND contacto = $2`,
                  [tenantId, senderId]
                );

                continue;
              }
            }

            // 2) Submenú con opciones
            if (opcionSeleccionada?.submenu?.opciones?.length) {
              const titulo = opcionSeleccionada.submenu.mensaje || 'Elige una opción:';
              const opcionesSm = opcionSeleccionada.submenu.opciones
                .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
                .join('\n');

              let menuSm = `💡 ${titulo}\n${opcionesSm}\n\nResponde con el número de la opción que deseas.`;

              try {
                const idMenu = await detectarIdioma(menuSm);
                if (idMenu && idMenu !== 'zxx' && idMenu !== idiomaDestino) {
                  menuSm = await traducirMensaje(menuSm, idiomaDestino);
                }
              } catch {}

              await sendMeta(menuSm);

              // ➕ seguimos en el flujo guiado
              await pool.query(
                `UPDATE clientes SET estado = 'menu_enviado'
                WHERE tenant_id = $1 AND contacto = $2`,
                [tenantId, senderId]
              );
              continue;
            }

            // Opción válida pero sin contenido → reenvía menú principal
            const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
            const opciones = flows[0].opciones
              .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
              .join('\n');

            let menu = `⚠️ Esa opción aún no tiene contenido. Elige otra.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;

            try {
              if (idiomaDestino !== 'es') {
                menu = await traducirMensaje(menu, idiomaDestino);
              }
            } catch {}

            await sendMeta(menu);
            continue;
          } else {
            // Número fuera de rango → menú principal
            const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
            const opciones = flows[0].opciones
              .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
              .join('\n');

            let menu = `⚠️ Opción no válida. Intenta de nuevo.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;

            try {
              if (idiomaDestino !== 'es') {
                menu = await traducirMensaje(menu, idiomaDestino);
              }
            } catch {}

            await sendMeta(menu);
            continue;
          }
        }

        // === Interceptor de principiantes (como WhatsApp) ===

        // 1) Intención canónica para usar en FAQ y en el interceptor
        let intencionParaFaq = '';
        try {
          // Detectamos en ES para consistencia, traduciendo si hace falta
          const textoES = (idiomaDestino === 'es') ? userMessage : await traducirMensaje(userMessage, 'es');
          const det0 = await detectarIntencion(textoES, tenantId, canalEnvio);
          let proc = (det0?.intencion || '').trim().toLowerCase();

          if (proc === 'duda') proc = buildDudaSlug(userMessage);       // duda → duda__subslug
          proc = normalizeIntentAlias(proc);                             // alias a canon

          // overrides por keywords
          const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
          if (priceRegex.test(userMessage)) {
            proc = 'precio';
          } else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) {
            proc = 'clases_online';
          }

          intencionParaFaq = proc;
        } catch {}

        // 2) promptBase (como en WhatsApp, pero alimentado desde meta_configs)
        const rawPrompt = tenant.prompt_meta?.trim() || 'Información del negocio no disponible.';
        let promptBase = rawPrompt;
        try {
          if (idiomaDestino !== 'es') {
            promptBase = await traducirMensaje(rawPrompt, idiomaDestino);
          }
        } catch { /* si falla, usamos rawPrompt */ }

        // 3) Ejecutar interceptor
        const interceptado = await runBeginnerRecoInterceptor({
          tenantId,
          canal: canalEnvio,             // 'facebook' | 'instagram'
          fromNumber: senderId,          // contacto
          userInput: userMessage,
          idiomaDestino,
          intencionParaFaq,
          promptBase,
          enviarFn: enviarMetaSeguro,    // wrapper que acabamos de crear
        });

        if (interceptado) {
          // Registrar interacción y cortar (ya respondió el interceptor)
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );
          continue;
        }
        // === fin interceptor ===

        // === Paso 2: FAQ directa por intención (global, igual WhatsApp) ===
        try {
          // Reutilizamos intencionParaFaq del interceptor; si está vacío, la calculamos
          let intentFAQ = (typeof intencionParaFaq === 'string' ? intencionParaFaq : '').trim().toLowerCase();

          if (!intentFAQ) {
            const textoES = (idiomaDestino === 'es') ? userMessage : await traducirMensaje(userMessage, 'es');
            const det1 = await detectarIntencion(textoES, tenantId, canalEnvio);
            let proc = (det1?.intencion || '').trim().toLowerCase();
            if (proc === 'duda') proc = buildDudaSlug(userMessage);  // duda -> duda__subslug
            proc = normalizeIntentAlias(proc);                       // alias -> canónica

            // overrides por keywords
            const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
            if (priceRegex.test(userMessage)) {
              proc = 'precio';
            } else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) {
              proc = 'clases_online';
            }
            intentFAQ = proc;
          }

          if (isDirectIntent(intentFAQ, INTENTS_DIRECT)) {
            let respuestaDesdeFaq: string | null = null;

            if (intentFAQ === 'precio') {
              // helper robusto para precio (alias/sub-slugs)
              respuestaDesdeFaq = await fetchFaqPrecio(tenantId, canalContenido); // 'meta'
            } else {
              const { rows: r } = await pool.query(
                `SELECT respuesta FROM faqs
                WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = LOWER($3)
                LIMIT 1`,
                [tenantId, canalContenido, intentFAQ]
              );
              respuestaDesdeFaq = r[0]?.respuesta || null;
            }

            if (respuestaDesdeFaq) {
              // Traducir a idioma del cliente si hace falta
              let out = respuestaDesdeFaq;
              try {
                const langOut = await detectarIdioma(out);
                if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                  out = await traducirMensaje(out, idiomaDestino);
                }
              } catch {}

              // Guardar mensaje del usuario (una sola vez)
              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
                ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                [tenantId, userMessage, canalEnvio, senderId || 'anónimo', messageId]
              );

              // Enviar y guardar respuesta
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

              // ❗Cortar aquí: no pasar a similitud/LLM si ya hubo FAQ directa
              continue;
            }
          }
        } catch (e) {
          console.warn('⚠️ FAQ directa global falló:', e);
        }
        // === fin Paso 2 ===

        const { intencion, nivel_interes } = await detectarIntencion(userMessage, tenant.id, 'facebook');
        const intencionLower = intencion?.toLowerCase() || '';

        let respuesta: string | null = null;

        if (["finalizar", "cerrar", "terminar", "gracias", "eso es todo", "no necesito más"].some(p => intencionLower.includes(p))) {
          respuesta = "¡Gracias por contactarnos! Si necesitas más información, no dudes en escribirnos. ¡Hasta pronto!";
        } else {
          // 1️⃣ Flujos guiados (Meta) → usando lógica traducida (idéntica a WhatsApp)
          const respuestaFlujoMeta = await buscarRespuestaDesdeFlowsTraducido(
            flows,
            userMessage,
            idioma
          );
          if (respuestaFlujoMeta) {
            respuesta = respuestaFlujoMeta;

            // Asegura idioma final
            const idiomaResp = await detectarIdioma(respuesta);
            if (idiomaResp && idiomaResp !== 'zxx' && idiomaResp !== idiomaDestino) {
              respuesta = await traducirMensaje(respuesta, idiomaDestino);
            }

            await sendMeta(respuesta);
            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
              VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
              ON CONFLICT (tenant_id, message_id) DO NOTHING`,
              [tenantId, respuesta, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
            );

            await pool.query(
              `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT DO NOTHING`,
              [tenantId, canalEnvio, messageId]
            );

            continue; // ⚠️ termina aquí si encontró coincidencia en el flujo
          }

            if (!respuesta) {
              const mensajeBienvenida = tenant.bienvenida_meta?.trim() || "Hola, soy Amy, ¿en qué puedo ayudarte hoy?";
              const promptMeta = tenant.prompt_meta?.trim() || "Información del negocio no disponible.";
            
              const saludoDetectado = ["hola", "hello", "buenos días", "buenas tardes", "buenas noches", "saludos"].some(p =>
                userMessage.toLowerCase().includes(p)
              );
            
              const dudaGenericaDetectada = ["quiero más información", "i want more information", "me interesa", "más detalles", "información"].some(p =>
                userMessage.toLowerCase().includes(p)
              );
            
              const nombreNegocio = tenant.nombre || tenant.name || 'tu negocio';

              if (saludoDetectado) {
                respuesta = mensajeBienvenida;
              } else if (dudaGenericaDetectada) {
                respuesta = "¡Claro! ¿Qué información específica te interesa? Puedo ayudarte con precios, servicios, horarios u otros detalles.";
              } else {
                // 🎯 Lógica de traducción para que el prompt se adapte al idioma del cliente
                const idiomaCliente = await detectarIdioma(userMessage);
                let promptMetaAdaptado = promptMeta;
                let promptGenerado = '';

                if (idiomaCliente !== 'es') {
                  try {
                    promptMetaAdaptado = await traducirMensaje(promptMeta, idiomaCliente);

                    promptGenerado = `You are Amy, a helpful virtual assistant for the local business "${nombreNegocio}". A customer asked: "${userMessage}". Respond clearly, briefly, and helpfully using the following information:\n\n${promptMetaAdaptado}`;
                  } catch (err) {
                    console.error('❌ Error traduciendo prompt_meta:', err);
                    promptGenerado = `You are Amy, a virtual assistant. A customer asked: "${userMessage}". Reply concisely.`;
                  }
                } else {
                  promptGenerado = `Eres Amy, una asistente virtual para el negocio local "${nombreNegocio}". Un cliente preguntó: "${userMessage}". Responde de forma clara, breve y útil usando esta información:\n\n${promptMeta}`;
                }

                try {
                  const completion = await openai.chat.completions.create({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'user', content: promptGenerado }],
                    max_tokens: 400,
                  });

                  respuesta = completion.choices[0]?.message?.content?.trim() || "Lo siento, no tengo información disponible.";
                  const tokensConsumidos = completion.usage?.total_tokens || 0;

                  // === Paso 3: registro de FAQ sugerida (dedupe + INTENT_UNIQUE) ===

                  // ⛔ No generes sugeridas si el mensaje NO tiene letras o es muy corto
                  const hasLetters = /\p{L}/u.test(userMessage);
                  if (!hasLetters || normalizarTexto(userMessage).length < 4) {
                    console.log('🧯 No se genera sugerida (sin letras o texto muy corto).');
                  } else {
                    // Asegura idioma de salida al cliente
                    try {
                      const idiomaRespuesta = await detectarIdioma(respuesta || '');
                      if (idiomaRespuesta && idiomaRespuesta !== 'zxx' && idiomaRespuesta !== idiomaDestino) {
                        respuesta = await traducirMensaje(respuesta || '', idiomaDestino);
                      }
                    } catch (e) {
                      console.warn('No se pudo traducir la respuesta de OpenAI:', e);
                    }

                    const preguntaNormalizada = normalizarTexto(userMessage);
                    const respuestaNormalizada = (respuesta || '').trim();

                    // Carga existentes (sugeridas y oficiales) para evitar duplicados
                    let sugeridasExistentes: any[] = [];
                    try {
                      const sugRes = await pool.query(
                        'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
                        [tenantId, canalContenido] // 'meta'
                      );
                      sugeridasExistentes = sugRes.rows || [];
                    } catch (error) {
                      console.error('⚠️ Error consultando FAQ sugeridas:', error);
                    }

                    // FAQs oficiales ya cargadas arriba en `faqs`
                    const yaExisteSug = yaExisteComoFaqSugerida(userMessage, respuesta || '', sugeridasExistentes);
                    const yaExisteAprob = yaExisteComoFaqAprobada(userMessage, respuesta || '', faqs);

                    if (yaExisteSug || yaExisteAprob) {
                      if (yaExisteSug) {
                        await pool.query(
                          `UPDATE faq_sugeridas
                            SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
                          WHERE id = $1`,
                          [yaExisteSug.id]
                        );
                        console.log(`⚠️ Pregunta similar ya sugerida (ID: ${yaExisteSug.id})`);
                      } else {
                        console.log(`⚠️ Pregunta ya registrada como FAQ oficial.`);
                      }
                    } else {
                      // Detecta intención en ES para guardar (canónica + subslug duda + overrides)
                      const textoESparaGuardar = (idiomaDestino === 'es') ? userMessage : await traducirMensaje(userMessage, 'es');
                      const detGuardar = await detectarIntencion(textoESparaGuardar, tenantId, canalEnvio);
                      let intencionFinal = (detGuardar?.intencion || '').trim().toLowerCase();

                      if (intencionFinal === 'duda') {
                        intencionFinal = buildDudaSlug(userMessage); // p.ej. duda__duracion_clase
                      }
                      intencionFinal = normalizeIntentAlias(intencionFinal);

                      // Overrides por keywords
                      const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
                      if (priceRegex.test(userMessage)) {
                        intencionFinal = 'precio';
                      } else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) {
                        intencionFinal = 'clases_online';
                      }

                      // Enforce unicidad para INTENT_UNIQUE
                      if (INTENT_UNIQUE.has(intencionFinal)) {
                        // ¿ya existe oficial?
                        const { rows: faqsOficiales } = await pool.query(
                          `SELECT 1 FROM faqs WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = LOWER($3) LIMIT 1`,
                          [tenantId, canalContenido, intencionFinal]
                        );
                        if (faqsOficiales.length > 0) {
                          console.log(`⚠️ Ya existe FAQ oficial con intención "${intencionFinal}". No se guarda sugerida.`);
                        } else {
                          // ¿ya existe sugerida con misma intención sin procesar?
                          const { rows: sugConInt } = await pool.query(
                            `SELECT 1 FROM faq_sugeridas
                              WHERE tenant_id = $1 AND canal = $2 AND procesada = false
                                AND LOWER(intencion) = LOWER($3)
                              LIMIT 1`,
                            [tenantId, canalContenido, intencionFinal]
                          );
                          if (sugConInt.length > 0) {
                            console.log(`⚠️ Ya existe FAQ sugerida con intención "${intencionFinal}". No se guarda duplicado.`);
                          } else {
                            await pool.query(
                              `INSERT INTO faq_sugeridas
                                (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                              VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                              [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idioma, intencionFinal]
                            );
                            console.log(`📝 Sugerida creada (única) intención="${intencionFinal}"`);
                          }
                        }
                      } else {
                        // Intenciones no-únicas (p.ej. múltiples dudas refinadas)
                        await pool.query(
                          `INSERT INTO faq_sugeridas
                            (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                          VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                          [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idioma, intencionFinal]
                        );
                        console.log(`📝 Sugerida creada (no-única) intención="${intencionFinal}"`);
                      }
                    }
                  }
                  // === fin Paso 3 ===

                  if (tokensConsumidos > 0) {
                    await pool.query(
                      `UPDATE uso_mensual SET usados = usados + $1
                      WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`,
                      [tokensConsumidos, tenantId]
                    );
                  }
                } catch (err) {
                  console.error('❌ Error con OpenAI:', err);
                  respuesta = "Lo siento, no tengo información disponible en este momento.";
                }
              }
            }                        
        }

        respuesta = respuesta ?? "Lo siento, no tengo información disponible.";
        const idiomaFinal = await detectarIdioma(respuesta);
        if (idiomaFinal && idiomaFinal !== 'zxx' && idiomaFinal !== idiomaDestino) {
          respuesta = await traducirMensaje(respuesta, idiomaDestino);
        }

        // 💡 Solo guardar si la intención es realmente de venta
        const intencionesValidas = ['comprar', 'pagar', 'precio', 'reservar'];

        if (intencionesValidas.includes(intencion) && nivel_interes >= 2) {
          await pool.query(
            `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, senderId, canalEnvio, userMessage, intencion, nivel_interes, messageId]
          );
        }

        // 📝 Guardar mensaje del usuario
        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
           VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
           [tenantId, userMessage, canalEnvio, senderId || 'anónimo', messageId]
        );        

        console.log(`🔍 Tenant ${tenantId} membresía_activa:`, tenant.membresia_activa, typeof tenant.membresia_activa);

        const yaExisteContenidoReciente = await pool.query(
          `SELECT 1 FROM messages WHERE tenant_id = $1 AND role = 'assistant' AND canal = $2 AND content = $3 
           AND timestamp >= NOW() - INTERVAL '5 seconds' LIMIT 1`,
           [tenantId, canalEnvio, respuesta]
        );        
        if (yaExisteContenidoReciente.rows.length === 0) {
          try {
            console.log('📤 Enviando mensaje a Meta...', { respuesta, canal: canalEnvio, senderId });

            await enviarMensajePorPartes({
              respuesta,
              senderId,
              tenantId,
              canal: canalEnvio,
              messageId,
              accessToken,
            });

            console.log('✅ Mensaje enviado correctamente.');
          } catch (err: any) {
            console.error('❌ Error al enviar mensaje por partes:', err?.response?.data || err.message || err);
          }
          
        }

        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
           VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
           [tenantId, respuesta, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
        );
        
        try {
          // Usa la intención ya detectada, pero canonízala para consistencia
          let intFinal = (intencionLower || '').trim().toLowerCase();
          if (intFinal === 'duda') {
            intFinal = buildDudaSlug(userMessage);
          }
          intFinal = normalizeIntentAlias(intFinal);
        
          // Overrides por keywords
          const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
          if (priceRegex.test(userMessage)) {
            intFinal = 'precio';
          } else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) {
            intFinal = 'clases_online';
          }
        
          // Segmentación como en WhatsApp
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
        
          await scheduleFollowUp(intFinal, nivel_interes ?? 1);
        } catch (e) {
          console.warn('⚠️ Error al evaluar/programar follow-up final:', e);
        }
        
        await pool.query(
          `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
           [tenant.id, canalEnvio, messageId]
        );

      }
    }
  } catch (error: any) {
    console.error('❌ Error en webhook:', error.response?.data || error.message || error);
  }
});

export default router;
