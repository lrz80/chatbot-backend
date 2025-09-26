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
import { getTenantTimezone } from '../../lib/getTenantTimezone';
import { checkAvailability } from '../../lib/availability';
import { getBookingConfig, checkAvailabilityNextClass } from '../../lib/booking';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

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

function getLinkFromTenant(tenant: any, keys: string[]): string | null {
  const pools = ['links','meta','config','settings','extras'];
  for (const p of pools) {
    try {
      const raw = tenant?.[p];
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj && typeof obj === 'object') {
        for (const k of keys) {
          if (typeof obj[k] === 'string' && obj[k]) return obj[k];
        }
      }
    } catch {}
  }
  for (const k of keys) {
    if (tenant && typeof tenant[k] === 'string' && tenant[k]) return tenant[k];
  }
  return null;
}

function to24hSafe(h?: string | null): string | null {
  if (!h) return null;
  const m = h.trim().match(/^([01]?\d|2[0-3])(?::?([0-5]\d))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? m[2] : '00';
  const ap = m[3]?.toLowerCase();
  if (ap === 'am') { if (hh === 12) hh = 0; }
  else if (ap === 'pm') { if (hh !== 12) hh += 12; }
  return `${String(hh).padStart(2,'0')}:${mm}`;
}

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

function addBookingCTA({
  out,
  intentLow,
  bookingLink,
  userInput
}: {
  out: string;
  intentLow: string;
  bookingLink?: string | null;
  userInput: string;
}) {
  if (!bookingLink) return out;

  // Evita duplicar el mismo link o añadir si ya hay alguna URL
  const alreadyHasLink = out.includes(bookingLink);
  if (alreadyHasLink) return out;

  const mustForce = intentLow === 'horario' || intentLow === 'reservar';
  const smellsLikeCta = /reserv|agenda|confirm/i.test(`${intentLow} ${userInput}`);

  if (mustForce || smellsLikeCta) {
    return out + `\n\nReserva aquí: ${bookingLink}`;
  }
  return out;
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

  const bookingLink =
  getLinkFromTenant(tenant, ['booking_url','booking','reservas_url','reservar_url','agenda_url']) || null;
  console.log('🔗 bookingLink resuelto =', bookingLink);

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

  // ✅ PON ESTO DESPUÉS de calcular idiomaDestino (y antes del pipeline)
  const greetingOnly = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|dias|días))?)\s*$/i.test(userInput.trim());
  const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i.test(userInput.trim());

  if (greetingOnly || thanksOnly) {
    const out = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
    try { await enviarWhatsApp(fromNumber, out, tenant.id); } catch {}
    return;
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

 // 3️⃣ Pipeline simple: INTENCIÓN → INTENCIONES(tabla) → FAQ → OPENAI
 
 let INTENCION_FINAL_CANONICA = '';
 let respuestaDesdeFaq: string | null = null;

 let hasTemporal = false;
 let scheduleHit = false;
 let reserveHit  = false;

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

  hasTemporal = timeLikeRe.test(lower) || dayWordRe.test(noAcc) || dayNameRe.test(noAcc);
  scheduleHit = scheduleHintRe.test(noAcc);
  reserveHit  = reserveHintRe.test(noAcc);

  console.log('[Temporal override v2]', { cleaned, hasTemporal, scheduleHit, reserveHit, INTENCION_FINAL_CANONICA });

  // === DISPONIBILIDAD EN TIEMPO REAL (si el tenant tiene booking.enabled) ===
  try {
    if (['horario','reservar'].includes((INTENCION_FINAL_CANONICA || '').toLowerCase())) {
      const timeZone = getTenantTimezone(tenant);

      // 1) Fecha base en TZ del tenant
      const now = new Date();
      const nowInTz = new Date(now.toLocaleString('en-US', { timeZone }));
      const base = new Date(nowInTz);

      const text = (userInput || '').toLowerCase();
      const saysManana = /(mañana|manana)/i.test(text);
      const saysHoy    = /\bhoy\b/i.test(text);

      // Si dijo "mañana", +1 día; si dijo "hoy" o nada, se queda en hoy
      if (saysManana) base.setDate(base.getDate() + 1);

      // --- NUEVO: mapear día de semana a fecha próxima ---
      const dayNameMap: Record<string, number> = {
        'domingo': 0, 'lunes': 1, 'martes': 2,
        'miercoles': 3, 'miércoles': 3,
        'jueves': 4, 'viernes': 5,
        'sabado': 6, 'sábado': 6,
      };
      function nextDow(from: Date, targetDow: number) {
        const d = new Date(from);
        const diff = (targetDow + 7 - d.getDay()) % 7 || 7; // próxima ocurrencia (no hoy)
        d.setDate(d.getDate() + diff);
        return d;
      }

      // Tomamos 'cleaned' (ya lo tienes arriba) para buscar día por nombre
      let targetDate = base;
      const dayNameMatch = cleaned.toLowerCase().match(/(domingo|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado)/);
      if (dayNameMatch) {
        const dow = dayNameMap[dayNameMatch[1]];
        targetDate = nextDow(base, dow);
      } else if (saysManana) {
        targetDate = new Date(base);
        targetDate.setDate(base.getDate() + 1);
      }

      // 2) Extraer hora solicitada (si viene)
      const match = text.match(/([01]?\d|2[0-3])([:.]\d{2})?\s*(am|pm)?/i);
      const horaPedida = match ? match[0].replace('.', ':') : null;

      function to24h(h?: string | null): string | null {
        if (!h) return null;
        const m = h.trim().match(/^([01]?\d|2[0-3])(?::?([0-5]\d))?\s*(am|pm)?$/i);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = m[2] ? m[2] : '00';
        const ap = m[3]?.toLowerCase();
        if (ap === 'am') { if (hh === 12) hh = 0; }
        else if (ap === 'pm') { if (hh !== 12) hh += 12; }
        return `${String(hh).padStart(2,'0')}:${mm}`;
      }

      const hora24 = to24hSafe(horaPedida);

      // 3) Formatear fecha YYYY-MM-DD en TZ del tenant **desde targetDate**
      const y = targetDate.getFullYear();
      const m = String(targetDate.getMonth() + 1).padStart(2, '0');
      const d = String(targetDate.getDate()).padStart(2, '0');
      const fechaISO = `${y}-${m}-${d}`;

      // 4) Revisar que el tenant tenga booking.enabled
      let bookingEnabled = false;
      try {
        const raw = tenant?.settings;
        const settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
        bookingEnabled = (settings?.booking?.enabled ?? false) || !!bookingLink;
      } catch {}

      if (bookingEnabled) {
        const q = { date: fechaISO, time: hora24 || undefined, service: undefined as any };
        const avail = await checkAvailability(tenant, q);
        console.log('🔍 RT availability resp:', JSON.stringify(avail));

        if (avail.ok && typeof avail.available === 'boolean') {
          const bookingLink =
            getLinkFromTenant(tenant, ['booking_url','booking','reservas_url','reservar_url','agenda_url']) || avail.booking_link || null;
            console.log('🔗 bookingLink resuelto =', bookingLink);

          if (avail.available) {
            let msg = `¡Listo! ${saysManana ? 'Mañana' : (saysHoy ? 'Hoy' : 'Para esa fecha')} ${hora24 ? `a las ${hora24}` : ''} hay cupos disponibles.`;
            if (typeof avail.remaining === 'number') msg += ` Quedan ${avail.remaining}.`;
            if (bookingLink) msg += `\n\nReserva aquí: ${bookingLink}`;
            console.log('🟩 RT → hay cupos, msg:', msg);
            await enviarWhatsApp(fromNumber, msg, tenant.id);
            // Registrar y cortar flujo como ya haces:
            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
              VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
              ON CONFLICT (tenant_id, message_id) DO NOTHING`,
              [tenant.id, msg, 'whatsapp', fromNumber || 'anónimo', `${messageId}-bot`]
            );
            await pool.query(
              `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT DO NOTHING`,
              [tenant.id, 'whatsapp', messageId]
            );
            return;
          } else {
            let msg = `Por ahora no veo cupos ${saysManana ? 'mañana' : (saysHoy ? 'hoy' : 'para esa fecha')}${hora24 ? ` a las ${hora24}` : ''}.`;
            if (avail.next_slots?.length) {
              const sug = avail.next_slots.slice(0,3).map(s => `• ${s.start}`).join('\n');
              msg += `\nOpciones cercanas:\n${sug}`;
            }
            const bookingLink =
              getLinkFromTenant(tenant, ['booking_url','booking','reservas_url','reservar_url','agenda_url']) || avail.booking_link || null;
              console.log('🔗 bookingLink resuelto =', bookingLink);

            if (bookingLink) msg += `\n\nPuedes reservar aquí: ${bookingLink}`;
            console.log('🟨 RT → sin cupos, msg:', msg);
            await enviarWhatsApp(fromNumber, msg, tenant.id);
            // Registrar y cortar flujo:
            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
              VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
              ON CONFLICT (tenant_id, message_id) DO NOTHING`,
              [tenant.id, msg, 'whatsapp', fromNumber || 'anónimo', `${messageId}-bot`]
            );
            await pool.query(
              `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT DO NOTHING`,
              [tenant.id, 'whatsapp', messageId]
            );
            return;
          }
        }
        // Si la API devolvió error o no respondió con available → seguimos al flujo normal (intenciones/FAQ/LLM)
      }
    }
  } catch (e) {
    console.warn('⚠️ checkAvailability falló (se continúa con flujo normal):', e);
  }

  // Regla general: si hay temporalidad + pista de horario → horario,
  // salvo que ya tengamos una acción más específica.
  const baseInt = (INTENCION_FINAL_CANONICA || '').toLowerCase();
  if (hasTemporal && scheduleHit && !['reservar','comprar','precio'].includes(baseInt)) {
    INTENCION_FINAL_CANONICA = 'horario';
    console.log('🎯 Override → horario (ampliado)');
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

 // --- NUEVO: atajo determinista sin RT para agenda ---
{
  const canon = (INTENCION_FINAL_CANONICA || '').toLowerCase();
  const isAgenda = ['horario','reservar'].includes(canon);

  if (isAgenda && hasTemporal) {
    // Variables locales PARA ESTE GUARD (evita fuera de scope)
    const cleanedForGuard = stripLeadGreetings(userInput);
    const dayNameMatch = cleanedForGuard.toLowerCase().match(/(domingo|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado)/);
    const saysMananaGuard = /(mañana|manana)/i.test(cleanedForGuard);
    const horaMatchForGuard = (userInput || '').toLowerCase().match(/([01]?\d|2[0-3])([:.]\d{2})?\s*(am|pm)?/i);
    const hora24 = to24hSafe(horaMatchForGuard ? horaMatchForGuard[0].replace('.', ':') : null);

    const cuando = saysMananaGuard ? 'mañana' : (dayNameMatch ? `el ${dayNameMatch[1]}` : 'esa fecha');
    const horaTxt = hora24 ? ` a las ${hora24}` : '';

    const msg = (`¡Genial! Para ${cuando}${horaTxt} te ayudo a reservar. ` +
                `Por favor confirma cupos y reserva aquí: ${bookingLink ?? ''}`).trim();

    try { await enviarWhatsApp(fromNumber, msg, tenant.id); } catch {}
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING`,
      [tenant.id, msg, 'whatsapp', fromNumber || 'anónimo', `${messageId}-bot`]
    );
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.id, 'whatsapp', messageId]
    );
    return; // evita LLM y cualquier alucinación/listado
  }
}

 // ✅ Fallback seguro para intención "horario" si no retornó nada arriba
  //    - Intenta una consulta simple a API (si existe vía getBookingConfig)
  //    - Siempre adjunta el link de reservas si lo hay
  const canon = (INTENCION_FINAL_CANONICA || '').toLowerCase();
  if (canon === 'horario' && (hasTemporal || reserveHit)) {
    try {
      const cfg = await getBookingConfig(tenant.id);
      let texto: string;

      if (cfg?.apiUrl) {
        const quick = await checkAvailabilityNextClass(cfg.apiUrl, cfg.headers);
        if (quick.hasClass && quick.whenText) {
          texto =
            `¡Hola! Según agenda, la próxima clase disponible es ${quick.whenText}.` +
            (cfg.bookingUrl ? ` Reserva aquí: ${cfg.bookingUrl}` : '');
        } else {
          const maniana = new Date(Date.now() + 24 * 60 * 60 * 1000);
          const manianaTxt = format(maniana, "EEEE d 'de' MMMM 'de' yyyy", { locale: es });
          texto =
            `¡Hola! No veo cupos confirmados ahora mismo para *mañana* (${manianaTxt}). ` +
            (cfg.bookingUrl ? `Puedes confirmar o revisar otras horas aquí: ${cfg.bookingUrl}` : 'Puedes intentar más tarde.');
        }
      } else {
        // Sin API → solo link (si existe)
        const maniana = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const manianaTxt = format(maniana, "EEEE d 'de' MMMM 'de' yyyy", { locale: es });
        const link =
          getLinkFromTenant(tenant, ['booking_url','booking','reservas_url','reservar_url','agenda_url']);
        texto =
          `¡Hola! Para *mañana* (${manianaTxt}) te sugiero confirmar disponibilidad en nuestro enlace de reservas.` +
          (link ? ` ${link}` : '');
      }

      // Enviar y registrar
      console.log('📝 Fallback horario → texto a enviar:', texto);
      try { await enviarWhatsApp(fromNumber, texto, tenant.id); } catch (e) { console.error('❌ WA (horario fallback):', e); }

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
        VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
        ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [tenant.id, texto, 'whatsapp', fromNumber || 'anónimo', `${messageId}-bot`]
      );
      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT DO NOTHING`,
        [tenant.id, 'whatsapp', messageId]
      );

      // (Opcional) programa follow-up solo si no hubo API o no hubo cupos
      try {
        const nivel2 = 1;
        const sinApi = !cfg?.apiUrl;
        if (sinApi) {
          await scheduleFollowUp('horario', nivel2);
        }
      } catch {}

      return; // corta flujo para no caer en intenciones/FAQ/LLM
    } catch (e) {
      console.warn('⚠️ Fallback de horario falló, continúo con pipeline:', e);
    }
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

        // 👉 CTA uniforme con helper
        const intentLow = (INTENCION_FINAL_CANONICA || '').toLowerCase();
        out = addBookingCTA({ out, intentLow, bookingLink, userInput });

        console.log('💬 INTENCION reply:', { intentLow, out });

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
   // 👉 CTA uniforme para FAQ (intención horario/reservar o si huele a CTA)
   const intentLowFaq = (INTENCION_FINAL_CANONICA || '').toLowerCase();
   out = addBookingCTA({ out, intentLow: intentLowFaq, bookingLink, userInput });

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

  // 🧠 Si no hubo FAQ/intención, genera con OpenAI usando el prompt del canal (con fecha/rails)
  if (!respuestaDesdeFaq) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  // ✅ Zona horaria del tenant (oficial)
  const timeZone = getTenantTimezone(tenant);

  // 2) Fechas absolutas para hoy/mañana en la zona del negocio
  const now = new Date();
  const nowInTz = new Date(
    now.toLocaleString('en-US', { timeZone })
  );
  const tomorrowInTz = new Date(nowInTz.getTime() + 24 * 60 * 60 * 1000);

  const fmtFecha = (d: Date) =>
    d.toLocaleDateString('es-ES', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone
    });

  const HOY = fmtFecha(nowInTz);        // ej. "miércoles, 24 de septiembre de 2025"
  const MANANA = fmtFecha(tomorrowInTz); // ej. "jueves, 25 de septiembre de 2025"

  // 3) Extraer hora solicitada (si viene)
  const lower = (userInput || '').toLowerCase();
  const horaMatch = lower.match(/([01]?\d|2[0-3])([:.]\d{2})?\s*(am|pm)?/i);
  const HORA_PEDIDA = horaMatch ? horaMatch[0].replace('.', ':') : null;

  // 4) ¿El usuario dijo explícitamente "mañana"?
  const DICE_MANANA = /(mañana|manana)/i.test(lower);

  // 5) Armar contexto explícito para el LLM
  const contextoFecha = [
    `ZONA_HORARIA_NEGOCIO: ${timeZone}`,
    `HOY: ${HOY}`,
    `MANANA: ${MANANA}`,
    `USUARIO_PREGUNTA: ${userInput}`,
    `PARSEO: ${[
      DICE_MANANA ? `pide = MANANA` : `pide = (no_detectado)`,
      HORA_PEDIDA ? `hora = ${HORA_PEDIDA}` : `hora = (no_detectada)`
    ].join(' | ')}`
  ].join('\n');

  // 6) Rails si es intención de agenda
  const isAgendaIntent = (['horario','reservar'].includes(canon)) && (hasTemporal || reserveHit);
  const systemPrompt = isAgendaIntent
    ? [
        promptBase,
        '',
        '=== CONTEXTO_DE_FECHA ===',
        contextoFecha,
        '',
        '=== REGLAS PARA HORARIOS/RESERVAS (SIN CALENDARIO EN TIEMPO REAL) ===',
      '- NO confirmes ni niegues disponibilidad, cancelaciones ni cupos.',
      '- NO listes horarios por día ni inventes franjas.',
      '- NO digas que “no hay clase” a una hora específica.',
      '- NO inventes horarios diferentes a los “horarios base” del negocio (si están en el prompt).',
      '- Si el usuario pide un día/hora (p. ej. "lunes 7:30pm"), repite esa intención y pide confirmar en el enlace de reservas.',
      '- Sé breve, amable y en el idioma del cliente.',
      ].join('\n')
    : [
        promptBase,
        '',
        '=== CONTEXTO_DE_FECHA ===',
        contextoFecha
      ].join('\n');

    const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 280,           // evita parrafadas largas
    presence_penalty: 0,
    frequency_penalty: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput }
    ],
  });

  respuesta = completion.choices[0]?.message?.content?.trim()
    || 'Puedo ayudarte con los horarios. ¿Te parece si lo confirmamos en el enlace de reservas o prefieres otra hora?';

  // 🌐 Ajuste de idioma de salida
  try {
    const idiomaRespuesta = await detectarIdioma(respuesta);
    if (idiomaRespuesta && idiomaRespuesta !== 'zxx' && idiomaRespuesta !== idiomaDestino) {
      respuesta = await traducirMensaje(respuesta, idiomaDestino);
    }
  } catch (e) {
    console.warn('No se pudo traducir la respuesta de OpenAI:', e);
  }

  // 👉 CTA uniforme para fallback OpenAI (según intención) **ANTES** de persistir
const intentLowOai = (INTENCION_FINAL_CANONICA || '').toLowerCase();
respuesta = addBookingCTA({ out: respuesta, intentLow: intentLowOai, bookingLink, userInput });

// Normalizaciones/registro con el **texto final**
const respuestaGeneradaLimpia = respuesta;
const preguntaNormalizada = normalizarTexto(userInput);
const respuestaNormalizada = respuestaGeneradaLimpia.trim();

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