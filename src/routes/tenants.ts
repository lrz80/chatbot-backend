// 📁 src/routes/tenants.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';
import { ensureUniqueSlug } from "../lib/slug";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ---------- Utils ----------
function isString(x: any): x is string { return typeof x === 'string'; }
/** Validación ligera de zona IANA (ej. America/Mexico_City). */
function isLikelyIana(tz: string) {
  return /^[A-Za-z]+\/[A-Za-z0-9_\-+]+$/.test(tz);
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
        id,
        name,
        slug,
        categoria,
        idioma,
        COALESCE(plan, 'trial')            AS plan,
        COALESCE(membresia_activa, false)  AS membresia_activa,
        membresia_inicio,
        prompt,
        mensaje_bienvenida AS bienvenida,
        onboarding_completado,
        settings,
        links,
        COALESCE(settings->'meta'->>'pixel_id', '') AS meta_pixel_id,
        COALESCE((settings->'meta'->>'pixel_enabled')::boolean, false) AS meta_pixel_enabled
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
// ✅ Actualizar perfil del negocio (parcial: name/categoria opcionales; guarda settings.* y links.*)
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1 LIMIT 1', [uid]);
    const user = userRes.rows[0];
    if (!user?.tenant_id) return res.status(404).json({ error: 'Usuario sin tenant asociado' });
    const tenantId = user.tenant_id as string;

    const {
      // básicos (todos OPCIONALES ahora)
      name,
      categoria,
      idioma,
      prompt,
      bienvenida,
      timezone,

      // booking URL (alias)
      booking_url,
      reservas_url,
      agenda_url,
      booking,

      // availability API + headers (alias)
      availability_api_url,
      booking_api_url,
      availability_headers,   // objeto o string JSON

      meta_pixel_id,
      meta_pixel_enabled,
    } = req.body || {};

    // 0) Normalizadores
    let slug: string | undefined = undefined;
    if (typeof name !== 'undefined') {
      // evita el 23505 al actualizar nombre/slug
      slug = await ensureUniqueSlug(pool, name, { excludeTenantId: tenantId });
    }

    const bookingUrlCandidate = firstString(booking_url, reservas_url, agenda_url, booking);
    const apiUrlCandidate = firstString(availability_api_url, booking_api_url);
    const headersObj = toPlainObject(availability_headers);

    // 1) Actualiza campos “planos” SOLO si vienen
    if (
      typeof name !== 'undefined' ||
      typeof categoria !== 'undefined' ||
      typeof idioma !== 'undefined' ||
      typeof prompt !== 'undefined' ||
      typeof bienvenida !== 'undefined'
    ) {
      // construye UPDATE dinámico
      const sets: string[] = [];
      const vals: any[] = [];
      let i = 1;

      if (typeof name !== 'undefined')      { sets.push(`name = $${i++}`); vals.push(name); }
      if (typeof slug !== 'undefined')      { sets.push(`slug = $${i++}`); vals.push(slug); }
      if (typeof categoria !== 'undefined') { sets.push(`categoria = $${i++}`); vals.push(categoria); }
      if (typeof idioma !== 'undefined')    { sets.push(`idioma = $${i++}`); vals.push(idioma); }
      if (typeof prompt !== 'undefined')    { sets.push(`prompt = $${i++}`); vals.push(prompt); }
      if (typeof bienvenida !== 'undefined'){ sets.push(`mensaje_bienvenida = $${i++}`); vals.push(bienvenida); }

      if (sets.length) {
        const sql = `
          UPDATE tenants
             SET ${sets.join(', ')},
                 onboarding_completado = true,   -- ⬅️ MARCA EL ONBOARDING
                 updated_at = NOW()
           WHERE id = $${i}
        `;
        await pool.query(sql, [...vals, tenantId]);
      }
    }
    // 2) Timezone → settings.timezone
    if (isString(timezone) && isLikelyIana(timezone)) {
      await pool.query(
        `UPDATE tenants
            SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{timezone}',
              to_jsonb($2::text),
              true
            ),
                updated_at = NOW()
          WHERE id = $1`,
        [tenantId, timezone]
      );
    }

    // 3) Booking URL → settings.booking.booking_url y links.booking.booking_url
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
               ),
               links = jsonb_set(
                 COALESCE(links, '{}'::jsonb),
                 '{booking,booking_url}',
                 to_jsonb($2::text),
                 true
               ),
               updated_at = NOW()
         WHERE id = $1`,
        [tenantId, bookingUrlCandidate]
      );
    }

    // 4) Availability API → settings.availability.api_url y links.availability.api_url
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
               ),
               links = jsonb_set(
                 COALESCE(links, '{}'::jsonb),
                 '{availability,api_url}',
                 to_jsonb($2::text),
                 true
               ),
               updated_at = NOW()
         WHERE id = $1`,
        [tenantId, apiUrlCandidate]
      );
    }

    // 5) Headers → settings.availability.headers y links.availability.headers
    if (headersObj) {
      await pool.query(
        `UPDATE tenants
           SET settings = jsonb_set(
                 COALESCE(settings, '{}'::jsonb),
                 '{availability,headers}',
                 to_jsonb($2::jsonb),
                 true
               ),
               links = jsonb_set(
                 COALESCE(links, '{}'::jsonb),
                 '{availability,headers}',
                 to_jsonb($2::jsonb),
                 true
               ),
               updated_at = NOW()
         WHERE id = $1`,
        [tenantId, headersObj]
      );
    }

    // 6) Devuelve estado actual
    const { rows } = await pool.query(
      `SELECT
        id,
        name,
        slug,
        categoria,
        idioma,
        COALESCE(plan, 'trial')            AS plan,
        COALESCE(membresia_activa, false)  AS membresia_activa,
        membresia_inicio,
        prompt,
        mensaje_bienvenida AS bienvenida,
        onboarding_completado,
        settings,
        links,

        -- CAMPOS PLANOS DEL PIXEL PARA QUE EL FRONT NO TENGA QUE NAVEGAR settings.json
        COALESCE(settings->'meta'->>'pixel_id', '') AS meta_pixel_id,
        COALESCE((settings->'meta'->>'pixel_enabled')::boolean, false) AS meta_pixel_enabled

      FROM tenants
      WHERE id = $1`,
      [tenantId]
    );

    // 7) Meta Pixel → settings.meta.pixel_id y settings.meta.pixel_enabled
    if (typeof meta_pixel_id !== 'undefined' || typeof meta_pixel_enabled !== 'undefined') {
      // Validación simple del Pixel ID (números)
      if (typeof meta_pixel_id !== 'undefined') {
        const pid = String(meta_pixel_id).trim();
        if (pid && !/^\d{10,20}$/.test(pid)) {
          return res.status(400).json({ error: 'Pixel ID inválido' });
        }

        await pool.query(
          `UPDATE tenants
            SET settings = jsonb_set(
                  COALESCE(settings, '{}'::jsonb),
                  '{meta,pixel_id}',
                  to_jsonb($2::text),
                  true
                ),
                updated_at = NOW()
          WHERE id = $1`,
          [tenantId, pid]
        );
      }

      if (typeof meta_pixel_enabled !== 'undefined') {
        const enabled = !!meta_pixel_enabled;

        await pool.query(
          `UPDATE tenants
            SET settings = jsonb_set(
                  COALESCE(settings, '{}'::jsonb),
                  '{meta,pixel_enabled}',
                  to_jsonb($2::boolean),
                  true
                ),
                updated_at = NOW()
          WHERE id = $1`,
          [tenantId, enabled]
        );
      }
    }

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

// ✅ GET /api/tenants/features — qué canales puede usar el tenant
router.get('/features', async (req: Request, res: Response) => {
   try {
     const tenantId = await getTenantIdFromCookie(req);
     const { rows } = await pool.query(
       `SELECT
          id, name, slug, categoria, idioma, prompt,
          mensaje_bienvenida AS bienvenida,
          plan, membresia_activa, es_trial, membresia_inicio, membresia_vigencia,
          settings, links
        FROM tenants
        WHERE id = $1`,
       [tenantId]
     );

    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'Tenant no encontrado' });

    const now = new Date();
    const trialActiva = !!t.es_trial && (!t.trial_ends_at || new Date(t.trial_ends_at) > now);

    // Reglas:
    // - WhatsApp: permitido si membresía activa OR trial activa
    // - Meta/Voice/Email/SMS: sólo si membresía activa Y no trial
    const whatsapp = t.membresia_activa || trialActiva;
    const otros = t.membresia_activa && !trialActiva;

    // (Opcional) puedes matizar por plan si quieres tiers más adelante
    const features = {
      whatsapp,
      meta: otros,
      voice: otros,
      sms: otros,
      email: otros,
    };

    return res.json({ plan: t.plan, membresia_activa: t.membresia_activa, es_trial: trialActiva, trial_ends_at: t.trial_ends_at, features });
  } catch (e) {
    console.error('❌ /api/tenants/features', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
