import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../lib/db';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);

    const totalRes = await pool.query(
      'SELECT COUNT(*) FROM messages WHERE uid = $1',
      [decoded.uid]
    );
    const uniqueUsersRes = await pool.query(
      'SELECT COUNT(DISTINCT sender_id) FROM messages WHERE uid = $1',
      [decoded.uid]
    );
    const peakHourRes = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count
       FROM messages WHERE uid = $1 GROUP BY hour ORDER BY count DESC LIMIT 1`,
      [decoded.uid]
    );

    return res.status(200).json({
      total: parseInt(totalRes.rows[0].count),
      usuarios: parseInt(uniqueUsersRes.rows[0].count),
      hora_pico: peakHourRes.rows.length > 0 ? parseInt(peakHourRes.rows[0].hour) : null
    });
  } catch (error) {
    console.error("❌ Error en /stats/kpis:", error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
