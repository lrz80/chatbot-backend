// 📁 chatbot-backend/routes/stats-monthly.ts

import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../lib/db';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const month = req.query.month || 'year';

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const uid = decoded.uid;

    let result;

    if (month === 'current') {
      result = await pool.query(
        `SELECT DATE(created_at) as dia, COUNT(*) as count
         FROM interactions
         WHERE uid = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
         GROUP BY dia ORDER BY dia`,
        [uid]
      );
    } else {
      result = await pool.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM') as mes, COUNT(*) as count
         FROM interactions
         WHERE uid = $1
         GROUP BY mes ORDER BY mes`,
        [uid]
      );
    }

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('❌ Error en /stats/monthly:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;