// 📁 src/routes/tenants.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ---------- Utils ----------
function isString(x: any): x is string { return typeof x === 'string'; }
/** Validación ligera de zona IANA (ej. America/Mexico_City). */
function isLikelyIana(tz: string) {
  return /^[A-Za-z]+\/[A-Za-z0-9_\-+]+$/.test(tz);
}
/** Normaliza el nombre a slug simple (sin acentos ni espacios). */
function toSlug(s: string) {
  return s
    .normalize('NFD').replace(/\p{M}/gu, '')  // quita acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')              // no letras/números -> -
    .replace(/^-+|-+$/g, '');                 // bordes
}
/** Devuelve el primer string no-vacío; si no hay, null. */
function firstString(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
/** URL válida (http/https). */
function isValidUrl(u?: string | null): u is string {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}
/** Convierte a objeto simple (si viene string JSON). */
function toPlainObject(x: any): Record<string, any> | null {
  if (!x) return null;
  if (typeof x === 'string') {
    try {
      const parsed = JSON.parse(x);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  if (typeof x === 'object' && !Array.isArray(x)) return x as Record<string, any>;
  return null;
}

// 🔎 Auth helper
async function getTenantIdFromCookie(req: Request): Promise<string> {
  const token = req.cookies?.token;
  if (!token) throw new Error('Token requerido');
  const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
  const uid = decoded.uid;
  const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1 LIMIT 1', [uid]);
  const user = userRes.rows[0];
  if (!user?.tenant_id) throw new Error('Usuario sin tenant asociado');
  return user.tenant_id as string;
}

// ✅ GET /api/tenants/me — trae el tenant con settings/links
router.get('/me', async (req: Request, res: Response) => {
  try {
    const tenantId = await getTenantIdFromCookie(req);
    const { rows } = await pool.query(
      `SELECT
         id, name, slug, categoria, idioma, prompt,
         mensaje_bienvenida AS bienvenida,
         settings, links
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json(rows[0]);
  } catch (e: any) {
    const msg = e?.message || 'Error';
    const code = msg.includes('Token') ? 401 : msg.includes('tenant') ? 404 : 500;
    if (code === 401 || code === 404) return res.status(code).json({ error: msg });
    console.error('❌ GET /api/tenants/me:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ✅ Actualizar perfil del negocio (timezone, booking_url, api_url, headers)
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1 LIMIT 1', [uid]);
    const user = userRes.rows[0];
    if (!user?.tenant_id) return res.status(404).json({ error: 'Usuario sin tenant asociado' });

    const {
      // básicos
      name,
      categoria,
      idioma = 'es',
      prompt = 'Eres un asistente útil.',
      bienvenida = '¡Hola! 👋 Soy tu asistente virtual. ¿En qué puedo ayudarte?',
      timezone, // puede venir del front

      // booking URL (varios alias soportados)
      booking_url,
      reservas_url,
      agenda_url,
      booking,

      // availability API + headers (varios alias)
      availability_api_url,
      booking_api_url,
      availability_headers,   // objeto o string JSON
    } = req.body || {};

    if (!name || !categoria) {
      return res.status(400).json({ error: 'Nombre y categoría son requeridos' });
    }

    const slug = toSlug(name);

    // 1) Actualiza campos “planos” (columna correcta: mensaje_bienvenida)
    await pool.query(
      `UPDATE tenants
         SET name = $1,
             slug = $2,
             categoria = $3,
             idioma = $4,
             prompt = $5,
             mensaje_bienvenida = $6
       WHERE id = $7`,
      [name, slug, categoria, idioma, prompt, bienvenida, user.tenant_id]
    );

    // 2) settings.timezone
    if (isString(timezone) && isLikelyIana(timezone)) {
      await pool.query(
        `UPDATE tenants
           SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb),
             '{timezone}',
             to_jsonb($2::text),
             true
           )
         WHERE id = $1`,
        [user.tenant_id, timezone]
      );
    }

    // 3) Booking URL -> settings.booking.booking_url + enabled
    const bookingUrlCandidate = firstString(booking_url, reservas_url, agenda_url, booking);
    if (isValidUrl(bookingUrlCandidate)) {
      await pool.query(
        `UPDATE tenants
           SET settings = jsonb_set(
             jsonb_set(
               COALESCE(settings, '{}'::jsonb),
               '{booking,booking_url}',
               to_jsonb($2::text),
               true
             ),
             '{booking,enabled}',
             'true'::jsonb,
             true
           )
         WHERE id = $1`,
        [user.tenant_id, bookingUrlCandidate]
      );
    }

    // 4) Availability API -> settings.availability.api_url (+enabled) y headers
    const apiUrlCandidate = firstString(availability_api_url, booking_api_url);
    if (isValidUrl(apiUrlCandidate)) {
      await pool.query(
        `UPDATE tenants
           SET settings = jsonb_set(
             jsonb_set(
               COALESCE(settings, '{}'::jsonb),
               '{availability,api_url}',
               to_jsonb($2::text),
               true
             ),
             '{availability,enabled}',
             'true'::jsonb,
             true
           )
         WHERE id = $1`,
        [user.tenant_id, apiUrlCandidate]
      );
    }

    const headersObj = toPlainObject(availability_headers);
    if (headersObj) {
      await pool.query(
        `UPDATE tenants
           SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb),
             '{availability,headers}',
             $2::jsonb,
             true
           )
         WHERE id = $1`,
        [user.tenant_id, JSON.stringify(headersObj)]
      );
    }

    // 5) Devuelve estado actual (alias mantiene 'bienvenida' para el front)
    const { rows } = await pool.query(
      `SELECT id, name, slug, categoria, idioma, prompt,
              mensaje_bienvenida AS bienvenida,
              settings
         FROM tenants
        WHERE id = $1`,
      [user.tenant_id]
    );
    res.status(200).json({ success: true, tenant: rows[0] });
  } catch (error) {
    console.error('❌ Error en /api/tenants:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// (Opcional) endpoint dedicado para actualizar solo la timezone
router.patch('/timezone', async (req: Request, res: Response) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1 LIMIT 1', [uid]);
    const user = userRes.rows[0];
    if (!user?.tenant_id) return res.status(404).json({ error: 'Usuario sin tenant asociado' });

    const tz = req.body?.timezone;
    if (!isString(tz) || !isLikelyIana(tz)) {
      return res.status(400).json({ error: 'Timezone inválida. Usa un identificador IANA, p. ej. America/Mexico_City' });
    }

    await pool.query(
      `UPDATE tenants
         SET settings = jsonb_set(
           COALESCE(settings, '{}'::jsonb),
           '{timezone}',
           to_jsonb($2::text),
           true
         )
       WHERE id = $1`,
      [user.tenant_id, tz]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('❌ Error en PATCH /api/tenants/timezone:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
