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
import { composePricingReserveMessage } from '../../lib/reply/composeMultiCat';
import { extractLinksFromPrompt } from '../../lib/links/fromPrompt';

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

  // ⬇️ Pega este bloque al inicio del handler del webhook de WhatsApp
  const rawFrom = String(req.body?.From || '');       // ej: 'whatsapp:+1863...'
  const rawTo   = String(req.body?.To || '');         // ej: 'whatsapp:+1463...'

  /**
   * numeroDestino:
   * - Si tu función enviarWhatsApp espera el formato Twilio ('whatsapp:+1...'), usa rawFrom.
   * - Si espera E.164 sin prefijo 'whatsapp:', usa fromE164.
   */
  const fromE164 = rawFrom.replace(/^whatsapp:/, ''); // '+1863...'
  const toE164   = rawTo.replace(/^whatsapp:/, '');   // '+1463...'

  // ⚠️ Ajusta esto según tu sender actual:
  const numeroDestino = rawFrom; // o usa fromE164 si tu enviarWhatsApp NO usa el prefijo 'whatsapp:'

  res.type('text/xml').send(new MessagingResponse().toString());

  setTimeout(async () => {
    try {
      await procesarMensajeWhatsApp(req.body);
    } catch (error) {
      console.error("❌ Error procesando mensaje:", error);
    }
  }, 2000);
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

function getTransactionalLink(tenant: any): string | null {
  return (
    getLinkFromTenant(tenant, [
      // reservas/turnos/mesas
      'booking_url','reservas_url','reservar_url','agenda_url',
      // ordering / e-commerce
      'checkout_url','cart_url','menu_url','order_url',
      // catálogo genérico
      'catalog_url','shop_url'
    ]) || null
  );
}

function parseLinksFromPrompt(promptText: string) {
  if (!promptText) {
    return {
      support: null,
      schedule: null,
      memberships: null,
      freeTrial: null,
      menu: null,
      order: null,
      checkout: null,
      catalog: null,
    };
  }

  const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  const bareUrlRe = /\bhttps?:\/\/[^\s)>\]]+/gi;

  type Found = { url: string; label: string; ctx: string; };
  const found: Found[] = [];

  // Markdown [label](url)
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(promptText))) {
    const label = (m[1] || '').trim();
    const url   = m[2].trim();
    const startCtx = Math.max(0, m.index - 80);
    const ctx = (promptText.slice(startCtx, m.index) + " " + label).toLowerCase();
    found.push({ url, label, ctx });
  }

  // URLs sueltas
  const existing = new Set(found.map(f => f.url));
  const bare = promptText.match(bareUrlRe) || [];
  for (const urlRaw of bare) {
    const url = urlRaw.trim();
    if (existing.has(url)) continue;
    const idx = promptText.indexOf(url);
    const startCtx = Math.max(0, idx - 80);
    const ctx = promptText.slice(startCtx, idx).toLowerCase();
    found.push({ url, label: url, ctx });
    existing.add(url);
  }

  // Palabras clave por categoría (sin depender de dominio)
  const saysSupport  = (t: string) => /(soporte|support|ayuda|contacto|contáctanos|asistencia)/i.test(t);
  const saysSchedule = (t: string) => /(horario|calendario|reserv|agenda|book|schedule|timetable|clases?)/i.test(t);
  const saysPricing  = (t: string) => /(precio|plan|membres[ií]a|pricing|rates|cost)/i.test(t);
  const saysTrial    = (t: string) => /(trial|cortes[ií]a|prueba\s*gratis|free\s*(class|trial)|demo)/i.test(t);
  const saysMenu     = (t: string) => /(menu|carta)/i.test(t);
  const saysOrder    = (t: string) => /(orden|order|pedido|delivery|env[ií]o|pickup|take\s*out)/i.test(t);
  const saysCheckout = (t: string) => /(checkout|cart)/i.test(t);
  const saysCatalog  = (t: string) => /(cat[aá]logo|catalog|shop|store)/i.test(t);

  // salidas
  let support: string | null = null;
  let schedule: string | null = null;
  let memberships: string | null = null;
  let freeTrial: string | null = null;
  let menu: string | null = null;
  let order: string | null = null;
  let checkout: string | null = null;
  let catalog: string | null = null;

  for (const f of found) {
    const url = f.url;
    const ctx = (f.ctx + " " + f.label).toLowerCase();

    if (!support && saysSupport(ctx)) {
      support = url; continue;
    }
    if (!freeTrial && saysTrial(ctx)) {
      freeTrial = url; continue;
    }
    if (!schedule && saysSchedule(ctx)) {
      schedule = url; continue;
    }
    if (!memberships && saysPricing(ctx)) {
      memberships = url; continue;
    }
    if (!menu && saysMenu(ctx)) {
      menu = url; continue;
    }
    if (!order && saysOrder(ctx)) {
      order = url; continue;
    }
    if (!checkout && saysCheckout(ctx)) {
      checkout = url; continue;
    }
    if (!catalog && saysCatalog(ctx)) {
      catalog = url; continue;
    }
  }

  return { support, schedule, memberships, freeTrial, menu, order, checkout, catalog };
}

// ===== Enlaces desde el propio prompt (markdown + URLs sueltas) =====
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
const BARE_URL = /\bhttps?:\/\/[^\s)>\]]+/gi;

function normalizeUrl(u: string) {
  try {
    const url = new URL(u.trim());
    // conserva el hash (necesario para rutas SPA tipo Glofox)
    // quita "/" final solo si NO hay hash
    if (url.pathname.endsWith('/') && url.pathname !== '/' && !url.hash) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // usar href para conservar hash tal cual
    return url.href;
  } catch {
    return u.trim();
  }
}

function extractAllLinksFromPrompt(promptText: string, max = 16): Array<{label: string, url: string}> {
  const found: Array<{label: string, url: string}> = [];
  // 1) markdown [label](url)
  let m: RegExpExecArray | null;
  while ((m = MD_LINK.exec(promptText)) && found.length < max) {
    found.push({ label: m[1].trim(), url: normalizeUrl(m[2]) });
  }
  // 2) bare urls (sin repetir)
  const existing = new Set(found.map(l => l.url));
  const bare = promptText.match(BARE_URL) || [];
  for (const raw of bare) {
    const url = normalizeUrl(raw);
    if (!existing.has(url)) {
      found.push({ label: url, url });
      existing.add(url);
      if (found.length >= max) break;
    }
  }
  // 3) de-dup por host+path
  const uniq = new Map<string, {label: string, url: string}>();
  for (const l of found) {
    try {
      const u = new URL(l.url);
      const key = `${u.hostname}${u.pathname}${u.hash}`;
      if (!uniq.has(key)) uniq.set(key, l);
    } catch {
      if (!uniq.has(l.url)) uniq.set(l.url, l);
    }
  }
  return Array.from(uniq.values()).slice(0, max);
}

function pickPromptLink({
  intentLow, bucket, text, promptLinks, tenant
}: {
  intentLow: string,
  bucket: 'AVAILABILITY'|'TRANSACTION'|'GEN',
  text: string,
  promptLinks: ReturnType<typeof parseLinksFromPrompt>,
  tenant: any
}) {
  const s = text.toLowerCase();

  // Señales por contenido (multinegocio)
  if (/(soporte|support|whatsapp|ayuda\s+t(?:e|é)cnica|contacto)/i.test(s) && promptLinks.support) 
  return promptLinks.support;

  if (/(precio|plan(es)?|membres[ií]a|cost|tarifa|rates|pricing)/i.test(s) && promptLinks.memberships) return promptLinks.memberships;
  if (/(clase\s+gratis|gratis|free\s+(class|trial)|free|trial|demo|cortes[ií]a)/i.test(s) && promptLinks.freeTrial) {
    return promptLinks.freeTrial;
  }

  if (/(menu|carta)/i.test(s) && promptLinks.menu) return promptLinks.menu;
  if (/(orden(ar)?|order|pedido|delivery|domicilio|env[ií]o|pickup|take\s*out)/i.test(s)) {
    if (promptLinks.order) return promptLinks.order;
    if (promptLinks.checkout) return promptLinks.checkout;
  }
  if (/(cat[aá]logo|catalog|shop|store)/i.test(s) && promptLinks.catalog) return promptLinks.catalog;

  // Por intención/bucket (reserva/horarios → schedule / order)
  if (bucket !== 'GEN' || intentLow === 'reservar' || intentLow === 'horario') {
    if (promptLinks.schedule) return promptLinks.schedule;
    if (promptLinks.order)    return promptLinks.order;
    if (promptLinks.checkout) return promptLinks.checkout;
  }

  // Fallback: lo que venga del tenant (links/meta/settings…)
  return getTransactionalLink(tenant);
}

// ===== Clasificar la pregunta del cliente (sin "preferido") =====
type QCategory =
  | 'FREE_TRIAL'
  | 'RESERVE'
  | 'PRICING'
  | 'SUPPORT'
  | 'MENU'
  | 'ORDER'
  | 'CATALOG'
  | 'NONE';

function classifyQuestion(userText: string, intentLow: string): QCategory {
  const s = (userText || '').toLowerCase();

  // Señales por texto del cliente
  if (/(gratis|free|trial|prueba|cortes[ií]a)/i.test(s)) return 'FREE_TRIAL';
  if (/(precio|plan(es)?|membres[ií]a|tarifa|rates|pricing)/i.test(s)) return 'PRICING';
  if (/(reserv(ar|a|o)|agenda(r)?|book|apart(ar|o)|cupos?|horario|schedule)/i.test(s)) return 'RESERVE';
  if (/(soporte|support|whatsapp|ayuda\s+t(?:e|é)cnica)/i.test(s)) return 'SUPPORT';
  if (/(menu|carta)/i.test(s)) return 'MENU';
  if (/(orden(ar)?|order|pedido|delivery|domicilio|env[ií]o|pickup|take\s*out)/i.test(s)) return 'ORDER';
  if (/(cat[aá]logo|catalog|shop|store)/i.test(s)) return 'CATALOG';

  // Señales por intención canónica (si llega)
  const i = (intentLow || '').toLowerCase();
  if (['reservar','horario','confirmar','reprogramar','cancelar','cambio','interes_clases'].includes(i)) return 'RESERVE';
  if (['precio','comprar'].includes(i)) return 'PRICING';

  return 'NONE';
}

// ===== Clasificar múltiples categorías desde un mismo mensaje =====
function classifyAllCategories(userText: string, intentLow: string): QCategory[] {
  const s = (userText || '').toLowerCase();
  const cats: QCategory[] = [];

  // por texto del cliente
  if (/(gratis|free|trial|prueba|cortes[ií]a)/i.test(s)) cats.push('FREE_TRIAL');
  if (/(precio|plan(es)?|membres[ií]a|tarifa|rates|pricing)/i.test(s)) cats.push('PRICING');
  if (/(reserv(ar|a|o)|agenda(r)?|book|apart(ar|o)|cupos?|horario|schedule)/i.test(s)) cats.push('RESERVE');
  if (/(soporte|support|whatsapp|ayuda\s+t(?:e|é)cnica)/i.test(s)) cats.push('SUPPORT');
  if (/(menu|carta)/i.test(s)) cats.push('MENU');
  if (/(orden(ar)?|order|pedido|delivery|domicilio|env[ií]o|pickup|take\s*out)/i.test(s)) cats.push('ORDER');
  if (/(cat[aá]logo|catalog|shop|store)/i.test(s)) cats.push('CATALOG');

  // por intención canónica
  const i = (intentLow || '').toLowerCase();
  if (['reservar','horario','confirmar','reprogramar','cancelar','cambio','interes_clases'].includes(i) && !cats.includes('RESERVE')) cats.push('RESERVE');
  if (['precio','comprar'].includes(i) && !cats.includes('PRICING')) cats.push('PRICING');

  // normaliza orden: FREE_TRIAL, PRICING, RESERVE, SUPPORT, MENU, ORDER, CATALOG, NONE
  const order: QCategory[] = ['FREE_TRIAL','PRICING','RESERVE','SUPPORT','MENU','ORDER','CATALOG'];
  const unique = Array.from(new Set(cats));
  const sorted = unique.sort((a,b) => order.indexOf(a) - order.indexOf(b));
  return sorted.length ? sorted : ['NONE'];
}

// ===== Elegir link según categoría detectada (desde links del prompt) =====
function selectLinkByCategory(
  category: QCategory,
  promptLinks: ReturnType<typeof parseLinksFromPrompt>,
  tenant: any,
  bookingLinkFallback?: string | null
): string | null {
  switch (category) {
    case 'FREE_TRIAL':
      return promptLinks.freeTrial || promptLinks.memberships || promptLinks.schedule || bookingLinkFallback || null;
    case 'RESERVE':
      return promptLinks.schedule || bookingLinkFallback || null;
    case 'PRICING':
      return promptLinks.memberships || null;
    case 'SUPPORT':
      return promptLinks.support || null;
    case 'MENU':
      return promptLinks.menu || null;
    case 'ORDER':
      return promptLinks.order || promptLinks.checkout || null;
    case 'CATALOG':
      return promptLinks.catalog || null;
    default:
      // último recurso: lo que el tenant tenga como transaccional
      return getTransactionalLink(tenant);
  }
}

// ===== Construir CTAs por categorías detectadas =====
function buildCategoryCTAs(
  categories: QCategory[],
  promptLinks: ReturnType<typeof parseLinksFromPrompt>,
  tenant: any,
  bookingLinkFallback?: string | null
): string[] {
  const lines: string[] = [];
  for (const cat of categories) {
    const url = selectLinkByCategory(cat, promptLinks, tenant, bookingLinkFallback);
    if (!url) continue;
    const text =
      cat === 'FREE_TRIAL' ? `Activa tu clase de cortesía aquí: ${url}` :
      cat === 'PRICING'    ? `Planes y precios: ${url}` :
      cat === 'RESERVE'    ? `Horarios y reservas: ${url}` :
      cat === 'SUPPORT'    ? `Soporte técnico: ${url}` :
      cat === 'MENU'       ? `Ver menú: ${url}` :
      cat === 'ORDER'      ? `Hacer pedido: ${url}` :
      /*CATALOG*/            `Ver catálogo: ${url}`;
    lines.push(text);
  }
  return lines;
}

// ===== Cortesía wording (ES/EN) =====
function applyCortesiaWording(out: string, userInput: string, idiomaDestino: 'es'|'en'): string {
  const s = `${userInput} ${out}`.toLowerCase();
  const askedFree = /(gratis|free|trial|prueba|cortes[ií]a)/i.test(s);
  if (!askedFree) return out;

  if (idiomaDestino === 'en') {
    if (!/\bcomplimentary\b/i.test(out)) {
      let replaced = out
        .replace(/\bfree trial\b/ig, 'free trial (complimentary)')
        .replace(/\bfree\b/ig, 'free (complimentary)');
      if (replaced === out) replaced = out + ' (complimentary).';
      return replaced;
    }
    return out;
  } else {
    if (!/\bde\s+cortes[ií]a\b/i.test(out)) {
      let replaced = out
        .replace(/\bprueba\s+gratis\b/ig, 'prueba gratis (de cortesía)')
        .replace(/\bgratis\b/ig, 'gratis (de cortesía)');
      if (replaced === out) replaced = out + ' (de cortesía).';
      return replaced;
    }
    return out;
  }
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

  // 🧩 Agregar mensajes recientes del mismo contacto (ventana de 30s)
  // Debe ir después del INSERT del mensaje 'user' y antes de detectar idioma/intención.
  const AGG_WINDOW_SECONDS = 30;

  // Trae mensajes del mismo contacto en la ventana, solo role='user'
  let aggregatedInput = userInput;
  try {
    const { rows: recentMsgs } = await pool.query(
      `
      SELECT role, content, timestamp
      FROM messages
      WHERE tenant_id = $1
        AND canal = 'whatsapp'
        AND from_number = $2
        AND role = 'user'
        AND timestamp >= NOW() - INTERVAL '${AGG_WINDOW_SECONDS} seconds'
      ORDER BY timestamp ASC
      `,
      [tenant.id, fromNumber]
    );

    // Si hay varios "trozos", júntalos en uno solo
    if (recentMsgs?.length) {
      const parts = recentMsgs.map(r => (r.content || '').trim()).filter(Boolean);

      // Evita que "hola / cómo estás" contaminen el intent
      const throwaway = /^(hola+|hello|hi|hey|buenas(\s+(tardes|noches|dias|días))?|como\s+estas|cómo\s+estás|\?+)$/i;
      const cleanedParts = parts.filter(p => !throwaway.test(p.trim()));

      if (cleanedParts.length) {
        aggregatedInput = cleanedParts.join(' ').replace(/\s+/g, ' ').trim();
      }
    }
  } catch (e) {
    console.warn('⚠️ No se pudo agregar mensajes recientes:', e);
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

  const idioma = await detectarIdioma(aggregatedInput);
  const promptBase = getPromptPorCanal('whatsapp', tenant, idioma);
  const promptLinks = parseLinksFromPrompt(String(promptBase || ''));
  let respuesta = '';
  const canal = 'whatsapp';
  
  // URL presente en el prompt (fallback si no hay link en settings/tenant)
  const promptUrl = extractFirstUrl(promptBase);

// 👇 PÉGALO AQUÍ (debajo de getLink)
function stripLeadGreetings(t: string) {
  return t
    .replace(/^\s*(hola+[\s!.,]*)?/i, '')
    .replace(/^\s*(saludos+[\s!.,]*)?/i, '')
    .replace(/^\s*(hello+|hi+|hey+)[\s!.,]*/i, '')
    .trim();
}

function extractFirstUrl(text?: string | null): string | null {
  if (!text) return null;
  const m = text.match(/\bhttps?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
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

  // Si ya hay esa misma URL o cualquier URL en el texto, no duplicar
  if (out.includes(bookingLink)) return out;

  // Intenciones donde SIEMPRE mostramos CTA
  const FORCE_INTENTS = new Set([
    'horario','reservar','comprar','confirmar','interes_clases',
    // 👉 añadimos casos de política/cancelación/reprogramación
    'cancelar','cancelacion','cancelación','reprogramar','cambiar','cambio'
  ]);

  // Si la intención cae en la lista forzada -> añade CTA
  if (FORCE_INTENTS.has((intentLow || '').toLowerCase())) {
    return out + `\n\nReserva/gestiona aquí: ${bookingLink}`;
  }

  // Palabras que huelen a transacción/gestión (por texto del usuario o del propio mensaje)
  const smellsLikeCta = /(reserv|agenda|confirm|cancel|cambi|reprogram|refun|devolu|pol[ií]tica)/i
    .test(`${intentLow} ${userInput} ${out}`);

  if (smellsLikeCta) {
    return out + `\n\nReserva/gestiona aquí: ${bookingLink}`;
  }

  return out;
}

// ===== Remover links irrelevantes según la categoría detectada =====
function stripLinksForCategory(out: string, category: ReturnType<typeof classifyQuestion>): string {
  // En consultas de FREE_TRIAL no queremos distraer con soporte (wa.me)
  if (category === 'FREE_TRIAL') {
    // 1) quita líneas sueltas con wa.me (bullets o líneas completas)
    out = out.replace(/^[ \t]*[-•]?\s*https?:\/\/wa\.me\/\d+[ \t]*\r?\n?/gim, '');
    // 2) quita wa.me embebido en medio del texto
    out = out.replace(/\bhttps?:\/\/wa\.me\/\d+\b/gi, '');
    // Limpia espacios dobles dejados por el replace
    out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  return out;
}

// Indica si ya armamos una respuesta multi-categoría (para omitir follow-up)
let resolvedMultiCat = false;

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

  // Cargar FAQ sugeridas existentes (para evitar duplicados)
  let sugeridasExistentes: any[] = [];
  try {
    const sugRes = await pool.query(
      `SELECT id, pregunta, respuesta_sugerida
        FROM faq_sugeridas
        WHERE tenant_id = $1 AND canal = $2`,
      [tenant.id, 'whatsapp']
    );
    sugeridasExistentes = sugRes.rows || [];
  } catch (error) {
    console.error('⚠️ Error consultando FAQ sugeridas:', error);
  }

  // 1️⃣ Detectar si es solo número
  const isNumericOnly = /^\s*\d+\s*$/.test(aggregatedInput);

  // 2️⃣ Calcular idiomaDestino
  const tenantBase: 'es'|'en' = normalizeLang(tenant?.idioma || 'es');
  let idiomaDestino: 'es'|'en';

  const bookingLink =
    getLinkFromTenant(tenant, ['booking_url','booking','reservas_url','reservar_url','agenda_url'])
    || promptLinks.schedule
    || promptUrl
    || null;
  console.log('🔗 bookingLink resuelto =', bookingLink);

  if (isNumericOnly) {
    idiomaDestino = await getIdiomaClienteDB(tenant.id, fromNumber, tenantBase);
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
  } else {
    let detectado: string | null = null;
    try { detectado = normLang(await detectarIdioma(aggregatedInput)); } catch {}
    const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
    await upsertIdiomaClienteDB(tenant.id, fromNumber, normalizado);
    idiomaDestino = normalizado;
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= aggregated`);
  }

  // ✅ PON ESTO DESPUÉS de calcular idiomaDestino (y antes del pipeline)
  const greetingOnly = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|dias|días))?)\s*$/i
    .test(aggregatedInput.trim());
  const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i
    .test(aggregatedInput.trim());

  if (greetingOnly || thanksOnly) {
  const hasMoreContentSoon = aggregatedInput && aggregatedInput !== (userInput || '').trim();
  if (!hasMoreContentSoon) {
    const out = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
    try { await enviarWhatsApp(fromNumber, out, tenant.id); } catch {}
    return;
  }
}

// 4) GEN → sigue el pipeline normal (FAQ/LLM)

  // ⏲️ Programador de follow-up (WhatsApp)
  async function scheduleFollowUp(intFinal: string, nivel: number) {
    // 🛑 Si ya entregamos respuesta multi-categoría completa en el mismo mensaje, no agendamos follow-up
    if (resolvedMultiCat) {
      console.log('🛑 Follow-up omitido: ya se entregó respuesta multi-pregunta (precios + horarios).');
      return;
    }

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
     ? await traducirMensaje(stripLeadGreetings(aggregatedInput), 'es').catch(() => aggregatedInput)
     : stripLeadGreetings(aggregatedInput);

   const det = await detectarIntencion(textoParaIntent, tenant.id, 'whatsapp');
   INTENCION_FINAL_CANONICA = normalizeIntentAlias((det?.intencion || '').trim().toLowerCase());

   // --- Override ligero por temporalidad (tolerante a acentos) ---
  const cleaned = stripLeadGreetings(aggregatedInput);

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

 } catch (e) {
   console.warn('⚠️ detectarIntencion falló:', e);
   INTENCION_FINAL_CANONICA = '';
 }

 // canon único para todo el flujo
 const canon = (INTENCION_FINAL_CANONICA || '').toLowerCase();

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
        const linkForThisIntent = pickPromptLink({
          intentLow,
          bucket: 'GEN',
          text: aggregatedInput,
          promptLinks,
          tenant
        });
        out = addBookingCTA({
          out,
          intentLow,
          bookingLink: linkForThisIntent,
          userInput: aggregatedInput
        });

        // 🆕 Clasificar TODAS las categorías que aparecen en el mensaje
        const cats = classifyAllCategories(aggregatedInput, intentLow);
        // 🆕 Si incluye FREE_TRIAL, elimina wa.me u otros de soporte (no aplica en tu ejemplo, pero queda robusto)
        if (cats.includes('FREE_TRIAL')) out = stripLinksForCategory(out, 'FREE_TRIAL' as any);

        // 🆕 Construir CTAs para cada categoría y agregarlas si faltan
        const ctas = buildCategoryCTAs(cats, promptLinks, tenant, bookingLink);
        for (const line of ctas) {
          const urlPart = line.split(': ')[1] || ''; // lo que va después de "Planes y precios: "
          if (urlPart && !out.includes(urlPart)) {
            out += `\n\n${line}`;
          }
        }

        console.log('🔎 Multi-cat WA[Intenciones]', { cats, ctas });

        // ✅ Aplica wording de cortesía UNA sola vez, al final (coherente con FAQ/OpenAI)
        out = applyCortesiaWording(out, aggregatedInput, idiomaDestino);

        console.log('💬 INTENCION reply (multi-cat):', { intentLow, cats, out });

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
        // follow-up intacto…
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
   const linkForFaq = pickPromptLink({
     intentLow: intentLowFaq,
     bucket: 'GEN',
     text: aggregatedInput,
     promptLinks,
     tenant
   });
  out = addBookingCTA({
    out,
    intentLow: intentLowFaq,
    bookingLink: linkForFaq,
    userInput: aggregatedInput
  });

  // 🔗 MÚLTIPLES categorías en un solo mensaje
  const cats = classifyAllCategories(aggregatedInput, intentLowFaq);
  
  // En FREE_TRIAL limpiamos wa.me si el LLM lo metió
  if (cats.includes('FREE_TRIAL')) out = stripLinksForCategory(out, 'FREE_TRIAL' as QCategory);
  const ctas = buildCategoryCTAs(cats, promptLinks, tenant, bookingLink);
  for (const line of ctas) {
    if (!out.includes(line.split(': ')[1])) {
      out += `\n\n${line}`;
    }
  }

  // ====== LINKS DESDE PROMPT DEL NEGOCIO (multitenant/multicanal) ======
  try {
    const promptBaseLocal = getPromptPorCanal('whatsapp', tenant, idiomaDestino);
    const links = extractLinksFromPrompt(String(promptBaseLocal || ''), 20);

    const hasRelevantCats = Array.isArray(cats) && cats.some(c => c === 'PRICING' || c === 'RESERVE');
    if (hasRelevantCats) {
      const msg = composePricingReserveMessage({
        cats,
        links: {
          memberships: links.bestMemberships,
          classes:     links.bestClasses,
          contact:     links.bestContact
        },
        hasDuoPlan: false
      });

      // Unificar en el MISMO mensaje (no dispares enviarWhatsApp aquí)
      const alreadyHasMembership = links.bestMemberships && out.includes(links.bestMemberships);
      const alreadyHasClasses    = links.bestClasses     && out.includes(links.bestClasses);

      if (!alreadyHasMembership || !alreadyHasClasses) {
        out += `\n\n${msg}`;
      }
      resolvedMultiCat = true;
    }
  } catch (e) {
    console.error('Error en multi-categoría (links desde prompt):', e);
  }

  console.log('🔎 Multi-cat WA[FAQ]', { cats, ctas });

  // 🟢 Wording de cortesía (aplicar UNA vez, al final, antes de traducir)
  out = applyCortesiaWording(out, aggregatedInput, idiomaDestino);

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

  // 🧠 Si no hubo FAQ/intención, responde SOLO con lo que esté en el prompt del tenant (sin RT, sin inventar)
if (!respuestaDesdeFaq) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  // (Opcional) contexto horario por claridad de redacción, pero sin confirmar nada:
  const timeZone = getTenantTimezone(tenant);
  const now = new Date();
  const nowInTz = new Date(now.toLocaleString('en-US', { timeZone }));
  const tomorrowInTz = new Date(nowInTz.getTime() + 24 * 60 * 60 * 1000);

  const fmtFecha = (d: Date) =>
    d.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone });

  const HOY = fmtFecha(nowInTz);
  const MANANA = fmtFecha(tomorrowInTz);

  const contextoFecha = [
    `ZONA_HORARIA_NEGOCIO: ${timeZone}`,
    `HOY: ${HOY}`,
    `MANANA: ${MANANA}`,
    `USUARIO_PREGUNTA: ${aggregatedInput}`
  ].join('\n');

  const systemPrompt = [
  promptBase,
  '',
  // === ENLACES OFICIALES (extraídos del prompt del negocio) ===
  (() => {
    const all = extractAllLinksFromPrompt(String(promptBase || ''), 16);
    all.sort((a, b) => b.url.length - a.url.length);
    if (!all.length) return '=== ENLACES_OFICIALES ===\n(No se detectaron URLs en el prompt del negocio).';
    const lines = all.map(l => `- ${l.url}`); // WhatsApp: URL cruda (no markdown)
    return ['=== ENLACES_OFICIALES ===', ...lines].join('\n');
  })(),
  '',
  '=== CONTEXTO_DE_FECHA ===',
  contextoFecha,
  '',
  '=== REGLAS DE RESPUESTA (ESTRICTAS) ===',
  '- Responde ÚNICAMENTE con información contenida en este prompt/base del negocio.',
  '- NO inventes productos, planes (duo, grupales, corporativos), políticas, horarios ni condiciones que no figuren explícitamente aquí.',
  '- Si el usuario pide algo que NO está en el prompt, respóndelo con una frase clara tipo: "Por el momento no tengo esa información en mis datos."',
  '- Cuando falte la información pedida, ofrece 1 enlace pertinente de la sección ENLACES_OFICIALES:',
  '    • Si preguntan por planes/precios → comparte el enlace de membresías/precios.',
  '    • Si necesitan hablar con alguien → comparte el enlace de soporte (si existe) .',
  '- Usa EXCLUSIVAMENTE URLs listadas en ENLACES_OFICIALES. No inventes enlaces ni uses acortadores.',
  '- Este canal es WhatsApp: pega la URL completa (sin markdown).',
  '- No confirmes disponibilidad/cupos/stock/fechas exactas a menos que estén explícitos en el prompt.',
  '- Si el usuario hace varias preguntas (p. ej., precios y horarios), responde ambos puntos y añade a lo sumo 1 enlace relevante por cada tema.',
  '- Mantén el idioma del cliente y sé breve.',
  '- Si ENLACES_OFICIALES no contiene ninguna URL pertinente para el tema consultado, dilo explícitamente y NO inventes enlaces.',
  '  ES: No cuento con un enlace oficial para esto en este momento.',
  '  EN: I don’t have an official link for that right now.',
  '- No listes ni pegues todo el bloque de ENLACES_OFICIALES. Usa como mucho 1–2 URLs pertinentes según el tema.',
  '- Solo puedes usar hosts/domains ya presentes en ENLACES_OFICIALES (mismo hostname). No agregues dominios nuevos ni subdominios no listados.',
  '- Si la consulta tiene varios temas, responde cada tema en UNA línea: “Tema: respuesta corta. <URL_si_corresponde>”.',
  '- Si no estás 100% seguro de un dato (porque no aparece en el prompt), responde que no lo tienes y ofrece el enlace pertinente si existe. No “deduzcas” ni completes.',
  '- Si la consulta combina varios temas, organiza la respuesta en “una línea por tema” con el formato:',
  '<Tema>: respuesta breve (máx. 1 oración). <URL_relevante_si_existe>',
  'Orden recomendado: Cortesía/Free trial → Precios → Horarios/Reservas → Soporte → Menú → Pedidos → Catálogo.',
  '- Etiquetas de tema (ES): Cortesía, Precios, Horarios/Reservas, Soporte, Menú, Pedidos, Catálogo.',
  '- Topic labels (EN): Complimentary, Pricing, Schedule/Bookings, Support, Menu, Orders, Catalog.',
  '',
  '=== PLANTILLAS CUANDO FALTA INFORMACIÓN ===',
  '- ES: "Por el momento no tengo esa información en mis datos. Estos son los planes disponibles: <URL_DE_MEMBRESIAS>. Si prefieres, te conecto con un asesor aquí: <URL_WA>."',
  '- EN: "At the moment I don’t have that information in my data. These are the available plans: <MEMBERSHIPS_URL>. If you prefer, I can connect you with an advisor here: <WA_URL>."',
  '',
  '=== REGLAS EXTRA MULTITENANT/MULTINEGOCIO ===',
  '- No mezcles información entre negocios. Responde únicamente con datos del presente prompt (tenant actual).',
  '- Usa exclusivamente URLs listadas en ENLACES_OFICIALES. Si no hay URL para un tema, dilo explícitamente y NO inventes enlaces.',
  '- Dominio permitido: solo enlaces cuyo hostname aparezca en ENLACES_OFICIALES. No agregues dominios nuevos ni acortadores.',
  '- Límite de enlaces: máximo 2 por respuesta y como mucho 1 por tema (p. ej., “precios” y “horarios”).',
  '- Formato WhatsApp: pega URL completas (sin markdown). No repitas la misma URL si ya la mencionaste en la respuesta.',
  '- Idioma: responde en el idioma del cliente y evita mezclar idiomas si no es necesario.',
  '- Unidades y moneda: conserva las del prompt (no conviertas ni “equivalgas” precios).',
  '- Disponibilidad/stock/fechas: no confirmes nada que no esté explícito en el prompt; dirige a la URL oficial si aplica.',
  '- Peticiones fuera de alcance (no descritas en el prompt): usa la plantilla de “no tengo esa información” + (1) link de precios o (2) wa.me de soporte, si existen.',
  '- “Gratis / free / prueba / cortesía”: cuando el cliente lo mencione, incluye la palabra “de cortesía” (ES) o “complimentary” (EN) y no ofrezcas wa.me salvo que el usuario pida hablar con alguien.',
  '- Privacidad: no solicites ni proceses datos sensibles por chat; para pagos/reservas remite al portal oficial.',
  '- Concisión: máximo 3 líneas de texto + CTAs. Si hay varias preguntas, responde cada tema en una línea con su URL (si existe).',
  '- Estilo determinista: no uses suposiciones, ejemplos hipotéticos ni textos “de relleno” que no estén en el prompt.'
].join('\n');

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 280,
    presence_penalty: 0,
    frequency_penalty: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: aggregatedInput }
    ],
  });

  let respuesta = completion.choices[0]?.message?.content?.trim()
    || 'Puedo ayudarte con la información disponible. Si necesitas confirmar algo específico, te comparto el enlace correspondiente.';

  // Ajuste de idioma si hiciera falta
  try {
    const idiomaRespuesta = await detectarIdioma(respuesta);
    if (idiomaRespuesta && idiomaRespuesta !== 'zxx' && idiomaRespuesta !== idiomaDestino) {
      respuesta = await traducirMensaje(respuesta, idiomaDestino);
    }
  } catch {}

  // (Opcional) CTA según tenant
  const intentLowOai = (INTENCION_FINAL_CANONICA || '').toLowerCase();
  const linkForGen = pickPromptLink({
    intentLow: intentLowOai,
    bucket: 'GEN',
    text: aggregatedInput,
    promptLinks,
    tenant
  });
  respuesta = addBookingCTA({
    out: respuesta,
    intentLow: intentLowOai,
    bookingLink: linkForGen || bookingLink, // si no encontró, usa tu fallback
    userInput: aggregatedInput
  });

  // 🟢 Lenguaje “de cortesía / complimentary” si el cliente lo pidió
  respuesta = applyCortesiaWording(respuesta, aggregatedInput, idiomaDestino);

  // 🔎 Categoriza por lo que pidió el cliente
  const category = classifyQuestion(aggregatedInput, intentLowOai);

  // 🚫 Si es FREE_TRIAL, elimina wa.me u otros enlaces de soporte
  respuesta = stripLinksForCategory(respuesta, category);

  // 🔗 Seleccionar link por lo que el cliente preguntó (sin “preferidos”)
  const cats = classifyAllCategories(aggregatedInput, intentLowOai);
  if (cats.includes('FREE_TRIAL')) respuesta = stripLinksForCategory(respuesta, 'FREE_TRIAL' as QCategory);
  const ctas = buildCategoryCTAs(cats, promptLinks, tenant, linkForGen || bookingLink);
  for (const line of ctas) {
    if (!respuesta.includes(line.split(': ')[1])) {
      respuesta += `\n\n${line}`;
    }
  }

  console.log('🔎 Multi-cat WA[OpenAI]', { cats, ctas });

  // Persistir + enviar
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
     VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
     ON CONFLICT (tenant_id, message_id) DO NOTHING`,
    [tenant.id, respuesta, 'whatsapp', fromNumber || 'anónimo', `${messageId}-bot`]
  );
  try { await enviarWhatsApp(fromNumber, respuesta, tenant.id); } catch (e) {
    console.error('❌ Error enviando WhatsApp (fallback OpenAI):', e);
  }
  console.log("📬 Respuesta enviada vía Twilio:", respuesta);

  await pool.query(
    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT DO NOTHING`,
    [tenant.id, 'whatsapp', messageId]
  );

  // Inteligencia de ventas + follow-up
  try {
    const det = await detectarIntencion(aggregatedInput, tenant.id, 'whatsapp');
    const nivel_interes = det?.nivel_interes ?? 1;
    const intFinal = (INTENCION_FINAL_CANONICA || '').toLowerCase();

    const intencionesCliente = ["comprar","compra","pagar","agendar","reservar","confirmar","interes_clases","precio"];
    if (intencionesCliente.some(p => intFinal.includes(p))) {
      await pool.query(
        `UPDATE clientes SET segmento = 'cliente'
         WHERE tenant_id = $1 AND contacto = $2
           AND (segmento = 'lead' OR segmento IS NULL)`,
        [tenant.id, fromNumber]
      );
    }

    await pool.query(
      `INSERT INTO sales_intelligence
        (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
      [tenant.id, fromNumber, 'whatsapp', aggregatedInput, intFinal, nivel_interes, messageId]
    );

    if (nivel_interes >= 3 || ["interes_clases","reservar","precio","comprar","horario"].includes(intFinal)) {
      await scheduleFollowUp(intFinal, nivel_interes);
    }
  } catch (err) {
    console.error("⚠️ Error en inteligencia de ventas o seguimiento:", err);
  }

  // (Opcional) sugerir FAQ si no existe (igual que en Meta)
  try {
    // Normaliza la pregunta original del usuario
    const preguntaN = normalizarTexto(aggregatedInput || '');

    // 1) Checar duplicado en sugeridas (usa el ARRAY cargado)
    const yaExisteSug = yaExisteComoFaqSugerida(aggregatedInput || '', respuesta || '', sugeridasExistentes);

    // 2) Checar duplicado en oficiales (usa el ARRAY `faqs` que ya cargas arriba)
    const yaExisteAprob = yaExisteComoFaqAprobada(aggregatedInput || '', respuesta || '', faqs);

    if (yaExisteSug || yaExisteAprob) {
      if (yaExisteSug) {
        // ya existe como sugerida → sólo incrementa contador y actualiza fecha
        await pool.query(
          `UPDATE faq_sugeridas
              SET veces_repetida = COALESCE(veces_repetida, 0) + 1,
                  ultima_fecha    = NOW()
            WHERE id = $1`,
          [yaExisteSug.id]
        );
        console.log(`🔁 Pregunta similar ya sugerida (ID: ${yaExisteSug.id})`);
      } else {
        console.log('🔁 Pregunta ya registrada como FAQ oficial.');
      }
    } else {
      // Nueva sugerencia (aplica un mínimo de longitud para evitar ruido)
      if (preguntaN.length >= 20) {
        await pool.query(
          `INSERT INTO faq_sugeridas (tenant_id, canal, pregunta, respuesta_sugerida, veces_repetida, ultima_fecha)
          VALUES ($1, $2, $3, $4, 1, NOW())`,
          [tenant.id, 'whatsapp', aggregatedInput, respuesta || null]
        );
        console.log('🆕 Pregunta sugerida creada.');
      }
    }
  } catch (e) {
    console.warn('⚠️ No se pudo sugerir FAQ:', e);
  }
  return;
  }
}