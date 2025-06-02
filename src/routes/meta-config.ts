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
    if (configRes.rows.length === 0) return res.status(200).json({}); // Retorna vacío si no hay configuración
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

    const { funciones_asistente, info_clave, prompt, bienvenida, idioma } = req.body;

    await pool.query(`
      INSERT INTO meta_configs (tenant_id, funciones_asistente, info_clave, prompt, bienvenida, idioma, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        funciones_asistente = EXCLUDED.funciones_asistente,
        info_clave = EXCLUDED.info_clave,
        prompt = EXCLUDED.prompt,
        bienvenida = EXCLUDED.bienvenida,
        idioma = EXCLUDED.idioma,
        updated_at = NOW()
    `, [tenantId, funciones_asistente, info_clave, prompt, bienvenida, idioma]);

    return res.status(200).json({ message: 'Configuración Meta guardada correctamente' });
  } catch (err) {
    console.error('❌ Error en PUT /api/meta-config:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
