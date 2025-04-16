// 📁 src/routes/auth.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../lib/db';
import { v4 as uuidv4 } from 'uuid';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ✅ Registro
router.post('/register', async (req: Request, res: Response) => {
  const { nombre, apellido, email, telefono, password } = req.body;

  if (!nombre || !apellido || !email || !telefono || !password) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }

  try {
    const exists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const uid = uuidv4();
    const owner_name = `${nombre} ${apellido}`;

    await pool.query(
      `INSERT INTO users (uid, email, password, role, owner_name, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [uid, email, password_hash, 'admin', owner_name]
    );

    const token = jwt.sign({ uid, email }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: false, // ⚠️ IMPORTANTE para localhost
      sameSite: 'lax', // ⚠️ IMPORTANTE para que funcione sin HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });    

    res.status(201).json({ uid });
  } catch (error) {
    console.error('❌ Error en registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ✅ Login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Correo y contraseña requeridos' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign({ uid: user.uid, email: user.email }, JWT_SECRET, {
      expiresIn: '7d',
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: false, // ⚠️ IMPORTANTE para localhost
      sameSite: 'lax', // ⚠️ IMPORTANTE para que funcione sin HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });    

    res.status(200).json({ uid: user.uid });
  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ✅ Validar sesión
router.post('/validate', async (req: Request, res: Response) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Token no encontrado' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    res.status(200).json({ uid: decoded.uid, email: decoded.email });
  } catch (error) {
    console.error('❌ Token inválido:', error);
    res.status(401).json({ error: 'Token inválido' });
  }
});

export default router;
