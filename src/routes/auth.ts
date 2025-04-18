// 📁 src/routes/auth.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../lib/db';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ✅ Transport para enviar emails
const transporter = nodemailer.createTransport({
  host: "mail.privateemail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

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
    const verification_code = Math.floor(100000 + Math.random() * 900000).toString();

    await pool.query(
      `INSERT INTO users (uid, email, password, role, owner_name, telefono, created_at, verificado, codigo_verificacion)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), false, $7)`,
      [uid, email, password_hash, 'admin', owner_name, telefono, verification_code]
    );

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: 'Verifica tu cuenta en AAMY',
      text: `Tu código de verificación es: ${verification_code}`,
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

    if (!user.verificado) {
      return res.status(403).json({ error: "Tu cuenta no está verificada. Revisa tu correo." });
    }
    
    const token = jwt.sign({ uid: user.uid, email: user.email }, JWT_SECRET, {
      expiresIn: '7d',
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
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
// auth/verify
router.post("/verify", async (req: Request, res: Response) => {
  const { email, codigo } = req.body;

  if (!email || !codigo) {
    return res.status(400).json({ error: "Email y código requeridos" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND codigo_verificacion = $2",
      [email, codigo]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Código inválido o expirado" });
    }

    await pool.query(
      "UPDATE users SET verificado = true, codigo_verificacion = NULL WHERE email = $1",
      [email]
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error en /verify:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});


export default router;
