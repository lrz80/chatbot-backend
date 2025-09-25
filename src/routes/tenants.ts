// 📁 src/routes/tenants.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// Utilidades pequeñas
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

// ✅ Actualizar perfil del negocio (y opcionalmente timezone)
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
      name,
      categoria,
      idioma = 'es',
      prompt = 'Eres un asistente útil.',
      bienvenida = '¡Hola! 👋 Soy tu asistente virtual. ¿En qué puedo ayudarte?',
      timezone, // 👈 puede venir del front (ej. Intl.DateTimeFormat().resolvedOptions().timeZone)
    } = req.body || {};

    if (!name || !categoria) {
      return res.status(400).json({ error: 'Nombre y categoría son requeridos' });
    }

    const slug = toSlug(name);

    // 1) Actualiza campos “planos”
    await pool.query(
      `UPDATE tenants
         SET name = $1,
             slug = $2,
             categoria = $3,
             idioma = $4,
             prompt = $5,
             bienvenida = $6
       WHERE id = $7`,
      [name, slug, categoria, idioma, prompt, bienvenida, user.tenant_id]
    );

    // 2) Si viene timezone y parece válida IANA, guárdala en settings.timezone
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

    // 3) Devuelve estado actual (incluye settings para que verifiques)
    const { rows } = await pool.query('SELECT id, name, slug, categoria, idioma, prompt, bienvenida, settings FROM tenants WHERE id = $1', [user.tenant_id]);
    res.status(200).json({ success: true, tenant: rows[0] });
  } catch (error) {
    console.error('❌ Error en /api/tenants:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// (Opcional pero útil) endpoint dedicado para actualizar solo la timezone
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
