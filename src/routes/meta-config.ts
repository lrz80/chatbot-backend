// src/routes/meta-config.ts
import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import jwt, { JwtPayload } from 'jsonwebtoken';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// GET: obtener configuración meta del tenant
router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
    const tenantId = userRes.rows[0]?.tenant_id;
    if (!tenantId) return res.status(404).json({ error: 'Usuario sin tenant asociado' });

    const configRes = await pool.query('SELECT * FROM meta_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
    if (configRes.rows.length === 0) {
      return res.status(200).json({}); // Retorna vacío si no hay configuración
    }

    return res.status(200).json(configRes.rows[0]);
  } catch (err) {
    console.error('❌ Error en GET /api/meta-config:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT: guardar configuración meta del tenant
router.put('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
    const tenantId = userRes.rows[0]?.tenant_id;
    if (!tenantId) return res.status(404).json({ error: 'Usuario sin tenant asociado' });

    const {
      prompt_meta,
      bienvenida_meta,
      faq,
      intents,
      facebook_page_id,
      facebook_page_name,
      facebook_access_token,
      instagram_page_id,
      instagram_page_name,
      instagram_business_account_id,
    } = req.body;

    await pool.query(`
      INSERT INTO meta_configs (
        tenant_id, prompt_meta, bienvenida_meta, faq, intents,
        facebook_page_id, facebook_page_name, facebook_access_token,
        instagram_page_id, instagram_page_name, instagram_business_account_id, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        prompt_meta = EXCLUDED.prompt_meta,
        bienvenida_meta = EXCLUDED.bienvenida_meta,
        faq = EXCLUDED.faq,
        intents = EXCLUDED.intents,
        facebook_page_id = EXCLUDED.facebook_page_id,
        facebook_page_name = EXCLUDED.facebook_page_name,
        facebook_access_token = EXCLUDED.facebook_access_token,
        instagram_page_id = EXCLUDED.instagram_page_id,
        instagram_page_name = EXCLUDED.instagram_page_name,
        instagram_business_account_id = EXCLUDED.instagram_business_account_id,
        updated_at = NOW()
    `, [
      tenantId, prompt_meta, bienvenida_meta, JSON.stringify(faq || []), JSON.stringify(intents || []),
      facebook_page_id, facebook_page_name, facebook_access_token,
      instagram_page_id, instagram_page_name, instagram_business_account_id
    ]);

    return res.status(200).json({ message: 'Configuración Meta guardada correctamente' });
  } catch (err) {
    console.error('❌ Error en PUT /api/meta-config:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
