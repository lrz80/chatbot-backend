// 📁 src/routes/usage.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

const CANALES = [
  { canal: 'whatsapp', limite: 1000 },
  { canal: 'voz', limite: 500 }, // en minutos
  { canal: 'meta', limite: 1000 },
  { canal: 'sms', limite: 500 },
  { canal: 'email', limite: 2000 },
  { canal: 'tokens_openai', limite: 500000 }, // tokens GPT
  { canal: 'almacenamiento', limite: 5120 }, // MB = 5 GB
  { canal: 'contactos', limite: 500 } // únicos/mes
];

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
    const mesActual = new Date().toISOString().substring(0, 7) + '-01';

    // Insertar filas por defecto para todos los canales
    for (const { canal, limite } of CANALES) {
      await pool.query(`
        INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
        VALUES ($1, $2, $3, 0, $4)
        ON CONFLICT (tenant_id, canal, mes) DO NOTHING
      `, [tenantId, canal, mesActual, limite]);
    }

    // Obtener los registros para este tenant y mes
    const usoRes = await pool.query(`
      SELECT canal, usados, limite
      FROM uso_mensual
      WHERE tenant_id = $1 AND mes = $2
    `, [tenantId, mesActual]);

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
