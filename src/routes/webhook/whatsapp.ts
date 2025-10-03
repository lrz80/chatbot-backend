// backend/src/routes/webhook/whatsapp.ts

import express from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';

import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaDesdeFlowsTraducido } from '../../lib/respuestasTraducidas';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { buildDudaSlug, normalizeIntentAlias, isDirectIntent } from '../../lib/intentSlug';
import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';
import { enviarWhatsApp } from '../../lib/senders/whatsapp';

// ===================== Config & Constantes =====================

// Umbral del intent-matcher (ENV), clamp 0.30–0.95
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const router = express.Router();
const mensajesProcesados = new Set<string>(); // dedupe por MessageSid

// ===================== Helpers generales =====================

const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base;
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';

function stripWhatsAppPrefix(s?: string | null) {
  // Twilio envía "whatsapp:+1xxxxxxxxxx"; persistimos contacto como el mismo string completo
  // Si prefieres sin prefijo, puedes devolver solo el número.
  return (s || '').trim();
}

function toE164FromTo(to: string) {
  // "whatsapp:+1xxxxxxxxxx" -> "+1xxxxxxxxxx"
  return (to || '').replace(/^whatsapp:/i, '').trim();
}

// Persistencia de idioma por cliente, como en tu webhook de Meta
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

function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  return Number.isFinite(m) && m > 0 ? m : fallbackMin;
}

// Carga FAQ oficial por intención (para canal WhatsApp)
async function getFaqByIntent(
  tenantId: string,
  intent: string
): Promise<{ pregunta: string; respuesta: string } | null> {
  const { rows } = await pool.query(
    `SELECT pregunta, respuesta
       FROM faqs
      WHERE tenant_id = $1
        AND canal = ANY($2::text[])
        AND LOWER(intencion) = LOWER($3)
      ORDER BY id DESC
      LIMIT 1`,
    [tenantId, ['whatsapp'], intent]
  );
  return rows[0] || null;
}

// Calcula ciclo mensual (uso_mensual)
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

// Envío en partes (WhatsApp). Si ya tienes algo similar, puedes reemplazarlo.
// Envío en partes (WhatsApp)
async function enviarWAporPartes(params: {
  tenantId: string,
  to: string,   // puede venir como "whatsapp:+1..."
  body: string
}) {
  const MAX = 1300; // margen seguro
  const chunks: string[] = [];
  const text = params.body || '';

  // Si tu helper espera E.164 sin "whatsapp:", quita el prefijo aquí:
  const toForHelper = params.to.replace(/^whatsapp:/i, '');

  for (let i = 0; i < text.length; i += MAX) {
    chunks.push(text.slice(i, i + MAX));
  }

  // ✅ LLAMADA CORRECTA (3 argumentos posicionales)
  for (const part of chunks) {
    await enviarWhatsApp(toForHelper, part, params.tenantId);
  }
}

// ===================== WHATSAPP (Twilio) =====================
// Twilio no requiere GET de verificación estilo Meta.
// Opcional: puedes exponer un GET de healthcheck aquí si lo deseas.

router.post('/api/whatsapp/webhook', async (req, res) => {
  // Responder 200 ASAP para Twilio
  res.type('text/xml'); // Twilio ignora el body si no envías TwiML; OK responder 200 vacío.
  res.status(200).send('');

  try {
    // Twilio: ver ejemplos del payload en tus logs
    // Campos típicos: From, To, Body, MessageSid, NumMedia, ProfileName...
    const fromRaw = stripWhatsAppPrefix(req.body.From);       // ej: "whatsapp:+1863...."
    const toRaw   = stripWhatsAppPrefix(req.body.To);         // ej: "whatsapp:+1463...."
    const userMessageRaw = (req.body.Body || '').toString();
    const messageId = (req.body.MessageSid || '').toString();
    const isNumericOnly = /^\s*\d+\s*$/.test(userMessageRaw);

    if (!fromRaw || !toRaw || !messageId) {
      console.log('⏭️ Webhook sin campos clave From/To/MessageSid. Ignorado.');
      return;
    }

    // Dedupe por MessageSid
    if (mensajesProcesados.has(messageId)) {
      console.log('⚠️ Dedupe: MessageSid ya procesado en memoria:', messageId);
      return;
    }
    mensajesProcesados.add(messageId);
    setTimeout(() => mensajesProcesados.delete(messageId), 60000);

    const fromNumber = fromRaw;              // contacto (mantenemos "whatsapp:+1...")
    const toNumberE164 = toE164FromTo(toRaw); // "+1xxxx" para match en DB si guardas así
    const userMessage = userMessageRaw.trim();
    const canalEnvio: 'whatsapp' = 'whatsapp';
    const canalContenido: 'whatsapp' = 'whatsapp';

    // -------- Resolver tenant por número destino (WhatsApp) --------
    // En tu modelo: tenants.twilio_number = "+1........"
    const { rows: trows } = await pool.query(
      `SELECT *
         FROM tenants
        WHERE twilio_number = $1
        LIMIT 1`,
      [toNumberE164]
    );

    if (trows.length === 0) {
      console.log('🚫 No se encontró tenant para To:', toNumberE164);
      return;
    }

    const tenant = trows[0];
    const tenantId = tenant.id;

    // Si ya procesado en DB, salir
    const existingMsg = await pool.query(
      `SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
      [tenantId, messageId]
    );
    if (existingMsg.rows.length > 0) return;

    // 🧹 Limpia follow-ups pendientes de este contacto en este canal
    try {
      await pool.query(
        `DELETE FROM mensajes_programados
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
        [tenantId, canalEnvio, fromNumber]
      );
    } catch (e) {
      console.warn('No se pudieron limpiar follow-ups pendientes:', e);
    }

    // ---------- Idioma destino ----------
    const tenantBase: 'es'|'en' = normalizeLang(tenant?.idioma || 'es');
    let idiomaDestino: 'es'|'en';

    if (isNumericOnly) {
      idiomaDestino = await getIdiomaClienteDB(tenantId, fromNumber, tenantBase);
      console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
    } else {
      let detectado: string | null = null;
      try { detectado = normLang(await detectarIdioma(userMessage)); } catch {}
      const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
      await upsertIdiomaClienteDB(tenantId, fromNumber, normalizado);
      idiomaDestino = normalizado;
      console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= userMessage`);
    }

    // ---------- Incremento de uso mensual (canal WhatsApp) ----------
    try {
      const { rows: tr } = await pool.query(
        'SELECT membresia_inicio FROM tenants WHERE id = $1',
        [tenantId]
      );
      const membresiaInicio = tr[0]?.membresia_inicio;
      if (membresiaInicio) {
        const cicloMes = cicloMesDesdeMembresia(membresiaInicio);
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1`,
          [tenantId, canalEnvio, cicloMes]
        );
      }
    } catch (e) {
      console.warn('No se pudo incrementar uso_mensual:', e);
    }

    // ---------- Gate de membresía (igual que en Meta: no responder si inactiva) ----------
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
        [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
      );
      return;
    }

    // ---------- Carga de FAQs / Flows (canal WhatsApp) ----------
    let faqs: any[] = [];
    let flows: any[] = [];
    try {
      const resFaqs = await pool.query(
        `SELECT pregunta, respuesta
           FROM faqs
          WHERE tenant_id = $1
            AND canal = ANY($2::text[])`,
        [tenantId, ['whatsapp']]
      );
      faqs = resFaqs.rows || [];
    } catch {}

    try {
      const { rows: fr } = await pool.query(
        'SELECT data FROM flows WHERE tenant_id = $1 AND canal = $2 LIMIT 1',
        [tenantId, canalContenido]
      );
      const raw = fr[0]?.data;
      flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(flows)) flows = [];
    } catch (e) {
      flows = [];
    }

    // ---------- Saludos / Gracias (respuesta corta) ----------
    const greetingOnly = /^\s*(hola|buenas(?:\s+(tardes|noches|d[ií]as))?|hello|hi|hey)\s*$/i.test(userMessage);
    const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i.test(userMessage);
    if (greetingOnly || thanksOnly) {
      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
         VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
         ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
      );

      const fallbackBienvenidaES = "Hola, soy Amy, ¿en qué puedo ayudarte hoy?";
      const mensajeBienvenida = (tenant.bienvenida_whatsapp?.trim() || fallbackBienvenidaES);

      let out = thanksOnly
        ? (idiomaDestino === 'es'
            ? "¡De nada! 💬 ¿Quieres ver otra opción del menú?"
            : "You're welcome! 💬 Would you like to see other options?")
        : mensajeBienvenida;

      try {
        const langOut = await detectarIdioma(out);
        if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
          out = await traducirMensaje(out, idiomaDestino);
        }
      } catch {}

      await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
         VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
         ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
      );

      return;
    }

    // ---------- "Quiero info" → menú de flows si existe ----------
    const nrm = (t: string) =>
      (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const nUser = nrm(userMessage);

    const esPedirInfo =
      /\bmas\s*info\b/.test(nUser) ||
      /\binfo\b/.test(nUser) ||
      /\binf\b/.test(nUser) ||
      /\bquiero\s+mas\b/.test(nUser) ||
      nUser.endsWith(' inf') ||
      nUser.includes('quiero informacion') ||
      nUser.includes('mas informacion');

    const keywordsInfo = [
      'quiero informacion','más información','mas informacion','info','necesito informacion',
      'deseo informacion','quiero saber','me puedes decir','quiero saber mas','i want info',
      'i want information','more info','more information','tell me more','inf',
    ];

    if (esPedirInfo || keywordsInfo.some(k => nUser.includes(nrm(k)))) {
      const flow = flows[0];
      if (flow?.opciones?.length > 0) {
        const pregunta = flow.pregunta || flow.mensaje || '¿Cómo puedo ayudarte?';
        const opciones = flow.opciones
          .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
          .join('\n');

        let menu = `💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
        if (idiomaDestino !== 'es') {
          try { menu = await traducirMensaje(menu, idiomaDestino); } catch {}
        }

        await enviarWAporPartes({ tenantId, to: fromNumber, body: menu });

        await pool.query(
          `UPDATE clientes SET estado = 'menu_enviado'
            WHERE tenant_id = $1 AND contacto = $2`,
          [tenantId, fromNumber]
        );
        return;
      }
    }

    // ---------- SOLO número → resolver flow inmediato ----------
    if (isNumericOnly && Array.isArray(flows[0]?.opciones) && flows[0].opciones.length) {
      const digitOnlyNum = userMessage.replace(/[^\p{N}]/gu, '').trim();
      const n = Number(digitOnlyNum);
      const opcionesNivel1 = flows[0].opciones;

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
         VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
         ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
      );

      if (Number.isInteger(n) && n >= 1 && n <= opcionesNivel1.length) {
        const opcionSeleccionada = opcionesNivel1[n - 1];

        // 1) Respuesta directa
        if (opcionSeleccionada?.respuesta) {
          let out = opcionSeleccionada.respuesta;
          try {
            const idiomaOut = await detectarIdioma(out);
            if (idiomaOut && idiomaOut !== 'zxx' && idiomaOut !== idiomaDestino) {
              out = await traducirMensaje(out, idiomaDestino);
            }
          } catch {}
          out += "\n\n💡 ¿Quieres ver otra opción del menú? Responde con el número de la opción que deseas.";
          await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
          );

          return;
        }

        // 1.5) Submenú terminal
        if (opcionSeleccionada?.submenu && !opcionSeleccionada?.submenu?.opciones?.length) {
          let out = opcionSeleccionada.submenu.mensaje || '';
          if (out) {
            try {
              const idiomaOut = await detectarIdioma(out);
              if (idiomaOut && idiomaOut !== 'zxx' && idiomaOut !== idiomaDestino) {
                out = await traducirMensaje(out, idiomaDestino);
              }
            } catch {}
            await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
               VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
               ON CONFLICT (tenant_id, message_id) DO NOTHING`,
              [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
            );

            await pool.query(
              `UPDATE clientes SET estado = 'fuera_menu'
                WHERE tenant_id = $1 AND contacto = $2`,
              [tenantId, fromNumber]
            );
            return;
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
          await enviarWAporPartes({ tenantId, to: fromNumber, body: menuSm });

          await pool.query(
            `UPDATE clientes SET estado = 'menu_enviado'
              WHERE tenant_id = $1 AND contacto = $2`,
            [tenantId, fromNumber]
          );
          return;
        }

        // Opción válida pero sin contenido → menú principal
        const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
        const opciones = flows[0].opciones
          .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
          .join('\n');
        let menu = `⚠️ Esa opción aún no tiene contenido. Elige otra.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
        if (idiomaDestino !== 'es') {
          try { menu = await traducirMensaje(menu, idiomaDestino); } catch {}
        }
        await enviarWAporPartes({ tenantId, to: fromNumber, body: menu });
        return;
      } else {
        // Número fuera de rango → menú principal
        const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
        const opciones = flows[0].opciones
          .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
          .join('\n');
        let menu = `⚠️ Opción no válida. Intenta de nuevo.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
        if (idiomaDestino !== 'es') {
          try { menu = await traducirMensaje(menu, idiomaDestino); } catch {}
        }
        await enviarWAporPartes({ tenantId, to: fromNumber, body: menu });
        return;
      }
    }

    // ==================== Intent matcher (tabla intenciones) ====================
    try {
      const idiomaDet: 'es' | 'en' = normalizeLang(normLang(await detectarIdioma(userMessage)) || tenantBase);
      const textoParaMatch = (idiomaDet === 'es')
        ? userMessage
        : await traducirMensaje(userMessage, 'es');

      const { buscarRespuestaPorIntencion } = await import('../../services/intent-matcher'); // lazy
      const respIntent = await buscarRespuestaPorIntencion({
        tenant_id: tenantId,
        canal: 'whatsapp',
        mensajeUsuario: textoParaMatch,
        idiomaDetectado: idiomaDet,
        umbral: INTENT_THRESHOLD,
      });

      if (respIntent) {
        let out = respIntent.respuesta;
        try {
          const langOut = await detectarIdioma(out);
          if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
            out = await traducirMensaje(out, idiomaDestino);
          }
        } catch {}

        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
           VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
        );

        await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
           VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
        );

        await pool.query(
          `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [tenantId, canalEnvio, messageId]
        );

        // Segmentación + follow-up (mismo criterio)
        try {
          const det = await detectarIntencion(userMessage, tenantId, canalEnvio);
          const nivel = det?.nivel_interes ?? 1;

          let intFinal = (respIntent.intent || '').toLowerCase();
          if (intFinal === 'duda') intFinal = buildDudaSlug(userMessage);
          intFinal = normalizeIntentAlias(intFinal);

          const priceRegex = /\b(precio|precios|costo|costos|cu[eé]sta[n]?|tarifa[s]?|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
          if (priceRegex.test(userMessage)) intFinal = 'precio';

          const intencionesCliente = ["comprar","compra","pagar","agendar","reservar","confirmar","interes_clases","precio"];
          if (intencionesCliente.some(p => intFinal.includes(p))) {
            await pool.query(
              `UPDATE clientes
                 SET segmento = 'cliente'
               WHERE tenant_id = $1 AND contacto = $2
                 AND (segmento = 'lead' OR segmento IS NULL)`,
              [tenantId, fromNumber]
            );
          }

          await scheduleFollowUp({ tenantId, canalEnvio, fromNumber, idiomaDestino, intFinal, nivel });
        } catch (e) {
          console.warn('⚠️ No se pudo programar follow-up post-intent:', e);
        }

        return; // ⚠️ corta aquí
      }
    } catch (e) {
      console.warn('⚠️ Intent matcher falló / no match:', e);
    }

    // ==================== Atajo PRECIO (WhatsApp) ====================
    try {
      const txt = (userMessage || '').toLowerCase();
      const priceRegex = /\b(precio|precios|costo|costos|cu[eé]sta[n]?|tarifa[s]?|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/;

      if (priceRegex.test(txt)) {
        const { rows } = await pool.query(
          `SELECT respuesta
             FROM intenciones
            WHERE tenant_id = $1
              AND canal = ANY($2::text[])
              AND activo = TRUE
              AND LOWER(nombre) = ANY($3::text[])
            ORDER BY prioridad ASC, id ASC
            LIMIT 1`,
          [tenantId, ['whatsapp'], ['precio','precios']]
        );

        const resp = rows[0]?.respuesta;
        if (resp) {
          let out = resp;
          try {
            const langOut = await detectarIdioma(out);
            if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
              out = await traducirMensaje(out, idiomaDestino);
            }
          } catch {}

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1,'user',$2,NOW(),$3,$4,$5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
          );

          await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1,'assistant',$2,NOW(),$3,$4,$5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
          );

          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1,$2,$3,NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );

          // Segmentación + follow-up
          try {
            await pool.query(
              `UPDATE clientes
                 SET segmento = 'cliente'
               WHERE tenant_id = $1 AND contacto = $2
                 AND (segmento = 'lead' OR segmento IS NULL)`,
              [tenantId, fromNumber]
            );
            const det = await detectarIntencion(userMessage, tenantId, canalEnvio);
            const nivel = det?.nivel_interes ?? 3;
            await scheduleFollowUp({ tenantId, canalEnvio, fromNumber, idiomaDestino, intFinal: 'precio', nivel });
          } catch (e) {
            console.warn('⚠️ No se pudo programar follow-up tras precio:', e);
          }

          return;
        }
      }
    } catch (e) {
      console.warn('⚠️ Atajo precio falló:', e);
    }

    // ==================== Atajos rápidos (reservar/horario/ubicacion/online) ====================
    function quickIntentOf(txtRaw: string) {
      const txt = (txtRaw || '').toLowerCase();
      const m = [
        { name: 'precio', aliases: ['precio','precios'], rx: /\b(precio|precios|costo|costos|cu[eé]sta[n]?|tarifa[s]?|mensualidad|membres[ií]a|price|prices|cost|fee|fees|price\s*list)\b/ },
        { name: 'reservar', aliases: ['reservar','reserva','agendar','agenda','booking','book'], rx: /\b(reserv[ae]r|reserva|agendar|agenda|booking|book)\b/ },
        { name: 'horario', aliases: ['horario','horarios'], rx: /\b(horario[s]?|schedule|times?)\b/ },
        { name: 'ubicacion', aliases: ['ubicacion','ubicación','direccion','dirección','address','location'], rx: /\b(ubicaci[oó]n|direcci[oó]n|address|location|d[oó]nde)\b/ },
        { name: 'clases_online', aliases: ['clases_online','online','virtual'], rx: /\b(online|en\s*linea|en\s*l[ií]nea|virtual(?:es|idad)?)\b/ },
      ];
      for (const it of m) if (it.rx.test(txt)) return it;
      return null;
    }

    try {
      const quick = quickIntentOf(userMessage);
      if (quick) {
        const { rows } = await pool.query(
          `SELECT respuesta
             FROM intenciones
            WHERE tenant_id = $1
              AND canal = ANY($2::text[])
              AND activo = TRUE
              AND LOWER(nombre) = ANY($3::text[])
            ORDER BY prioridad ASC, id ASC
            LIMIT 1`,
          [tenantId, ['whatsapp'], quick.aliases.map(s => s.toLowerCase())]
        );

        const resp = rows[0]?.respuesta;
        if (resp) {
          let out = resp;
          try {
            const langOut = await detectarIdioma(out);
            if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
              out = await traducirMensaje(out, idiomaDestino);
            }
          } catch {}

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1,'user',$2,NOW(),$3,$4,$5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
          );

          await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1,'assistant',$2,NOW(),$3,$4,$5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
          );

          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1,$2,$3,NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );

          // Segmentación + follow-up
          try {
            const intFinal = (quick.name || '').toLowerCase();
            const intencionesCliente = ["comprar","compra","pagar","agendar","reservar","confirmar","interes_clases","precio"];
            if (intencionesCliente.some(p => intFinal.includes(p))) {
              await pool.query(
                `UPDATE clientes
                   SET segmento = 'cliente'
                 WHERE tenant_id = $1 AND contacto = $2
                   AND (segmento = 'lead' OR segmento IS NULL)`,
                [tenantId, fromNumber]
              );
            }
            const det = await detectarIntencion(userMessage, tenantId, canalEnvio);
            const nivel = det?.nivel_interes ?? 2;
            await scheduleFollowUp({ tenantId, canalEnvio, fromNumber, idiomaDestino, intFinal, nivel });
          } catch (e) {
            console.warn('⚠️ No se pudo programar follow-up en atajo rápido:', e);
          }

          return;
        }
      }
    } catch (e) {
      console.warn('⚠️ Atajos de intención fallaron:', e);
    }

    // ==================== Interceptor principiantes + FAQ directa ====================
    // 1) calcular intención canónica para FAQ / interceptor
    let intencionParaFaq = '';
    try {
      const textoES = (idiomaDestino === 'es') ? userMessage : await traducirMensaje(userMessage, 'es');
      const det0 = await detectarIntencion(textoES, tenantId, canalEnvio);
      let proc = (det0?.intencion || '').trim().toLowerCase();

      if (proc === 'duda') proc = buildDudaSlug(userMessage);
      proc = normalizeIntentAlias(proc);

      const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
      if (priceRegex.test(userMessage)) proc = 'precio';
      else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) proc = 'clases_online';

      intencionParaFaq = proc;
    } catch {}

    // 2) prompt base (WhatsApp): si usas columna específica, cámbiala aquí
    const rawPrompt = (tenant.prompt_whatsapp?.trim() || tenant.prompt?.trim() || 'Información del negocio no disponible.');
    let promptBase = rawPrompt;
    try {
      if (idiomaDestino !== 'es') promptBase = await traducirMensaje(rawPrompt, idiomaDestino);
    } catch {}

    // Intent-first → FAQ oficial y corta
    if (isDirectIntent(intencionParaFaq, INTENTS_DIRECT)) {
      const oficial = await getFaqByIntent(tenantId, intencionParaFaq);
      if (oficial?.respuesta) {
        let out = oficial.respuesta;
        try {
          const langOut = await detectarIdioma(out);
          if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
            out = await traducirMensaje(out, idiomaDestino);
          }
        } catch {}

        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
           VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
        );

        await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
           VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
        );

        await pool.query(
          `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [tenantId, canalEnvio, messageId]
        );
        return;
      }
    }

    // 3) Interceptor de principiantes (reutiliza tu interceptor; solo cambia canal)
    const { runBeginnerRecoInterceptor } = await import('../../lib/recoPrincipiantes/interceptor');

    const enviarWASeguro = async (_to: string, text: string, _tenantId: string) => {
      await enviarWAporPartes({ tenantId, to: fromNumber, body: text });
    };

    const interceptado = await runBeginnerRecoInterceptor({
      tenantId,
      canal: canalEnvio,          // 'whatsapp'
      fromNumber,
      userInput: userMessage,
      idiomaDestino,
      intencionParaFaq,
      promptBase,
      enviarFn: enviarWASeguro,
    });

    if (interceptado) {
      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [tenantId, canalEnvio, messageId]
      );
      return;
    }

    // 4) FAQ directa global (si quedó pendiente)
    try {
      let intentFAQ = (typeof intencionParaFaq === 'string' ? intencionParaFaq : '').trim().toLowerCase();
      if (!intentFAQ) {
        const textoES = (idiomaDestino === 'es') ? userMessage : await traducirMensaje(userMessage, 'es');
        const det1 = await detectarIntencion(textoES, tenantId, canalEnvio);
        let proc = (det1?.intencion || '').trim().toLowerCase();
        if (proc === 'duda') proc = buildDudaSlug(userMessage);
        proc = normalizeIntentAlias(proc);

        const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
        if (priceRegex.test(userMessage)) proc = 'precio';
        else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) proc = 'clases_online';
        intentFAQ = proc;
      }

      if (isDirectIntent(intentFAQ, INTENTS_DIRECT)) {
        let respuestaDesdeFaq: string | null = null;

        if (intentFAQ === 'precio') {
          respuestaDesdeFaq = await fetchFaqPrecio(tenantId, canalContenido);
        } else {
          const { rows: r } = await pool.query(
            `SELECT respuesta
               FROM faqs
              WHERE tenant_id = $1
                AND canal = ANY($2::text[])
                AND LOWER(intencion) = LOWER($3)
              LIMIT 1`,
            [tenantId, ['whatsapp'], intentFAQ]
          );
          respuestaDesdeFaq = r[0]?.respuesta || null;
        }

        if (respuestaDesdeFaq) {
          let out = respuestaDesdeFaq;
          try {
            const langOut = await detectarIdioma(out);
            if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
              out = await traducirMensaje(out, idiomaDestino);
            }
          } catch {}

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
          );

          await enviarWAporPartes({ tenantId, to: fromNumber, body: out });

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, out, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
          );

          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );
          return;
        }
      }
    } catch (e) {
      console.warn('⚠️ FAQ directa global falló:', e);
    }

    // ==================== Flows traducidos ====================
    const idiomaDet = await detectarIdioma(userMessage);
    let respuesta: string | null = null;

    const respuestaFlujoWA = await buscarRespuestaDesdeFlowsTraducido(
      flows,
      userMessage,
      idiomaDet
    );

    if (respuestaFlujoWA) {
      respuesta = respuestaFlujoWA;
      const idiomaResp = await detectarIdioma(respuesta);
      if (idiomaResp && idiomaResp !== 'zxx' && idiomaResp !== idiomaDestino) {
        respuesta = await traducirMensaje(respuesta, idiomaDestino);
      }

      await enviarWAporPartes({ tenantId, to: fromNumber, body: respuesta });

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
         VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
         ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [tenantId, respuesta, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
      );

      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [tenantId, canalEnvio, messageId]
      );

      return;
    }

    // ==================== Fallback: OpenAI con prompt del tenant ====================
    if (!respuesta) {
      const mensajeBienvenida = tenant.bienvenida_whatsapp?.trim() || "Hola, soy Amy, ¿en qué puedo ayudarte hoy?";
      const promptWA = rawPrompt;

      const saludoDetectado = ["hola", "hello", "buenos días", "buenas tardes", "buenas noches", "saludos"]
        .some(p => userMessage.toLowerCase().includes(p));
      const dudaGenericaDetectada = ["quiero más información", "i want more information", "me interesa", "más detalles", "información"]
        .some(p => userMessage.toLowerCase().includes(p));
      const nombreNegocio = tenant.nombre || tenant.name || 'tu negocio';

      if (saludoDetectado) {
        respuesta = mensajeBienvenida;
      } else if (dudaGenericaDetectada) {
        respuesta = "¡Claro! ¿Qué información específica te interesa? Puedo ayudarte con precios, servicios, horarios u otros detalles.";
      } else {
        const idiomaCliente = await detectarIdioma(userMessage);
        let promptAdaptado = promptWA;
        let promptGenerado = '';

        if (idiomaCliente !== 'es') {
          try {
            promptAdaptado = await traducirMensaje(promptWA, idiomaCliente);
            promptGenerado = `You are Amy, a helpful virtual assistant for "${nombreNegocio}". A customer asked: "${userMessage}". Respond clearly, briefly, and helpfully using the following info:\n\n${promptAdaptado}`;
          } catch {
            promptGenerado = `You are Amy, a virtual assistant. A customer asked: "${userMessage}". Reply concisely.`;
          }
        } else {
          promptGenerado = `Eres Amy, una asistente virtual para el negocio "${nombreNegocio}". Un cliente preguntó: "${userMessage}". Responde de forma clara, breve y útil usando esta información:\n\n${promptWA}`;
        }

        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: promptGenerado }],
            max_tokens: 400,
          });

          respuesta = completion.choices[0]?.message?.content?.trim() || "Lo siento, no tengo información disponible.";
          const tokensConsumidos = completion.usage?.total_tokens || 0;

          // Guardar FAQ sugerida (con dedupe e INTENT_UNIQUE) — igual que en Meta
          const hasLetters = /\p{L}/u.test(userMessage);
          if (hasLetters && normalizarTexto(userMessage).length >= 4) {
            try {
              const idiomaRespuesta = await detectarIdioma(respuesta || '');
              if (idiomaRespuesta && idiomaRespuesta !== 'zxx' && idiomaRespuesta !== idiomaDestino) {
                respuesta = await traducirMensaje(respuesta || '', idiomaDestino);
              }

              const preguntaNormalizada = normalizarTexto(userMessage);
              const respuestaNormalizada = (respuesta || '').trim();

              // cargar sugeridas existentes (canal whatsapp) y faqs oficiales
              let sugeridasExistentes: any[] = [];
              try {
                const sugRes = await pool.query(
                  'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
                  [tenantId, canalContenido]
                );
                sugeridasExistentes = sugRes.rows || [];
              } catch {}

              const yaExisteSug = yaExisteComoFaqSugerida(userMessage, respuesta || '', sugeridasExistentes);
              const yaExisteAprob = yaExisteComoFaqAprobada(userMessage, respuesta || '', faqs);

              if (yaExisteSug) {
                await pool.query(
                  `UPDATE faq_sugeridas
                    SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
                   WHERE id = $1`,
                  [yaExisteSug.id]
                );
              } else if (!yaExisteAprob) {
                const textoESparaGuardar = (idiomaDestino === 'es') ? userMessage : await traducirMensaje(userMessage, 'es');
                const detGuardar = await detectarIntencion(textoESparaGuardar, tenantId, canalEnvio);
                let intencionFinal = (detGuardar?.intencion || '').trim().toLowerCase();
                if (intencionFinal === 'duda') intencionFinal = buildDudaSlug(userMessage);
                intencionFinal = normalizeIntentAlias(intencionFinal);

                const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
                if (priceRegex.test(userMessage)) intencionFinal = 'precio';
                else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) intencionFinal = 'clases_online';

                if (INTENT_UNIQUE.has(intencionFinal)) {
                  const { rows: faqsOficiales } = await pool.query(
                    `SELECT 1
                       FROM faqs
                      WHERE tenant_id = $1
                        AND canal = ANY($2::text[])
                        AND LOWER(intencion) = LOWER($3)
                      LIMIT 1`,
                    [tenantId, ['whatsapp'], intencionFinal]
                  );
                  if (faqsOficiales.length === 0) {
                    const { rows: sugConInt } = await pool.query(
                      `SELECT 1 FROM faq_sugeridas
                        WHERE tenant_id = $1 AND canal = $2 AND procesada = false
                          AND LOWER(intencion) = LOWER($3)
                        LIMIT 1`,
                      [tenantId, canalContenido, intencionFinal]
                    );
                    if (sugConInt.length === 0) {
                      await pool.query(
                        `INSERT INTO faq_sugeridas
                          (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                         VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                        [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idiomaDet, intencionFinal]
                      );
                    }
                  }
                } else {
                  await pool.query(
                    `INSERT INTO faq_sugeridas
                      (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                     VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                    [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idiomaDet, intencionFinal]
                  );
                }
              }
            } catch (e) {
              console.warn('FAQ sugerida: no se pudo guardar', e);
            }
          }

          if (tokensConsumidos > 0) {
            await pool.query(
              `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
               VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE)::date, $2)
               ON CONFLICT (tenant_id, canal, mes)
               DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
              [tenantId, tokensConsumidos]
            );
          }
        } catch (err) {
          console.error('❌ Error con OpenAI:', err);
          respuesta = "Lo siento, no tengo información disponible en este momento.";
        }
      }
    }

    // ==================== Envío final + registros ====================
    respuesta = respuesta ?? "Lo siento, no tengo información disponible.";
    const idiomaFinal = await detectarIdioma(respuesta);
    if (idiomaFinal && idiomaFinal !== 'zxx' && idiomaFinal !== idiomaDestino) {
      respuesta = await traducirMensaje(respuesta, idiomaDestino);
    }

    // Sales intelligence (solo intenciones de venta y nivel >=2)
    try {
      const { intencion, nivel_interes } = await detectarIntencion(userMessage, tenantId, canalEnvio);
      const intencionLower = (intencion || '').toLowerCase();
      if (['comprar','pagar','precio','reservar'].includes(intencionLower) && (nivel_interes ?? 0) >= 2) {
        await pool.query(
          `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id, fecha)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, fromNumber, canalEnvio, userMessage, intencion, nivel_interes, messageId]
        );
      }
    } catch {}

    // Guardar user
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING`,
      [tenantId, userMessage, canalEnvio, fromNumber || 'anónimo', messageId]
    );

    // Evitar duplicado exacto reciente
    const yaExisteContenidoReciente = await pool.query(
      `SELECT 1 FROM messages
        WHERE tenant_id = $1 AND role = 'assistant' AND canal = $2 AND content = $3
          AND timestamp >= NOW() - INTERVAL '5 seconds' LIMIT 1`,
      [tenantId, canalEnvio, respuesta]
    );

    if (yaExisteContenidoReciente.rows.length === 0) {
      await enviarWAporPartes({ tenantId, to: fromNumber, body: respuesta });
    }

    // Guardar assistant
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING`,
      [tenantId, respuesta, canalEnvio, fromNumber || 'anónimo', `${messageId}-bot`]
    );

    // Segmentación + follow-up final
    try {
      const det = await detectarIntencion(userMessage, tenantId, canalEnvio);
      let intFinal = (det?.intencion || '').trim().toLowerCase();
      if (intFinal === 'duda') intFinal = buildDudaSlug(userMessage);
      intFinal = normalizeIntentAlias(intFinal);

      const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
      if (priceRegex.test(userMessage)) intFinal = 'precio';
      else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userMessage)) intFinal = 'clases_online';

      const intencionesCliente = ["comprar","compra","pagar","agendar","reservar","confirmar","interes_clases","precio"];
      if (intencionesCliente.some(p => intFinal.includes(p))) {
        await pool.query(
          `UPDATE clientes
             SET segmento = 'cliente'
           WHERE tenant_id = $1 AND contacto = $2
             AND (segmento = 'lead' OR segmento IS NULL)`,
          [tenantId, fromNumber]
        );
      }

      const nivel = det?.nivel_interes ?? 1;
      await scheduleFollowUp({ tenantId, canalEnvio, fromNumber, idiomaDestino, intFinal, nivel });
    } catch (e) {
      console.warn('⚠️ Error al evaluar/programar follow-up final:', e);
    }

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenantId, canalEnvio, messageId]
    );

  } catch (error: any) {
    console.error('❌ Error en webhook WhatsApp:', error?.response?.data || error.message || error);
  }
});

// ==================== Follow-up scheduler ====================
async function scheduleFollowUp(args: {
  tenantId: string,
  canalEnvio: 'whatsapp',
  fromNumber: string,
  idiomaDestino: 'es'|'en',
  intFinal: string,
  nivel: number
}) {
  const { tenantId, canalEnvio, fromNumber, idiomaDestino, intFinal, nivel } = args;
  try {
    const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
    const condition = (nivel >= 3) || intencionesFollowUp.includes((intFinal || '').toLowerCase());
    if (!condition) return;

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

    const ins = await pool.query(
      `INSERT INTO mensajes_programados
        (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id`,
      [tenantId, canalEnvio, fromNumber, msg, fechaEnvio]
    );

    console.log('📅 Follow-up programado', {
      id: ins.rows[0]?.id, tenantId, canal: canalEnvio,
      contacto: fromNumber, delayMin, fechaEnvio: fechaEnvio.toISOString()
    });
  } catch (e) {
    console.warn('⚠️ No se pudo programar follow-up:', e);
  }
}

export default router;
