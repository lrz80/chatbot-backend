import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ✅ GET → Obtener el prompt actual
router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    const tenantRes = await pool.query(
      'SELECT prompt FROM tenants WHERE admin_uid = $1',
      [uid]
    );

    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    return res.status(200).json({
      system_prompt: tenantRes.rows[0].prompt,
    });
  } catch (error) {
    console.error('❌ Error obteniendo prompt:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ✅ POST → Guardar nuevo prompt
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;
    const { system_prompt } = req.body;

    if (!system_prompt) {
      return res.status(400).json({ error: 'Prompt requerido' });
    }

    const updateRes = await pool.query(
      'UPDATE tenants SET prompt = $1 WHERE admin_uid = $2 RETURNING id',
      [system_prompt, uid]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    return res.status(200).json({ message: 'Prompt actualizado' });
  } catch (error) {
    console.error('❌ Error actualizando prompt:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
