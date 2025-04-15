import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../lib/db';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1]; // Bearer <token>

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);

    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    return res.status(200).json({ uid: user.uid, email: user.email, owner_name: user.owner_name });
  } catch (err) {
    console.error('❌ Error en /settings:', err);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

export default router;
