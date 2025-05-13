// 📁 src/routes/usage.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];

    if (!user?.tenant_id) {
      return res.status(404).json({ error: 'Usuario sin tenant asociado' });
    }

    const tenantId = user.tenant_id;

    // ✅ Insertar fila por defecto para SMS si no existe
    await pool.query(`
      INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
      VALUES ($1, 'sms', date_trunc('month', CURRENT_DATE), 0, 500)
      ON CONFLICT (tenant_id, canal, mes) DO NOTHING
    `, [tenantId]);

    const usoRes = await pool.query(`
      SELECT canal, usados, limite
      FROM uso_mensual
      WHERE tenant_id = $1 AND mes = date_trunc('month', CURRENT_DATE)
    `, [tenantId]);

    return res.status(200).json({
      usos: usoRes.rows,
      plan: "custom",
    });

  } catch (error) {
    console.error('❌ Error en /usage:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
