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

    const tenantRes = await pool.query(
      'SELECT used, limite_uso, plan FROM tenants WHERE id = $1',
      [user.tenant_id]
    );

    if (tenantRes.rows.length === 0) {
      return res.status(200).json({ used: 0, limit: 0, porcentaje: 0, plan: "free" });
    }

    const { used, limite_uso, plan } = tenantRes.rows[0];
    const porcentaje = limite_uso > 0 ? Math.round((used / limite_uso) * 100) : 0;

    return res.status(200).json({
      used: used || 0,
      limit: limite_uso || 0,
      porcentaje,
      plan: plan || "free",
    });
  } catch (error) {
    console.error('❌ Error en /usage:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;

