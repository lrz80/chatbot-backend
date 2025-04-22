// 📁 src/routes/auth.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../lib/db';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import { sendVerificationEmail } from '../lib/mailer';


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

// ✅ Registro corregido
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

    // ✅ Token de verificación (expira en 10 minutos)
    const token_verificacion = jwt.sign({ uid, email }, JWT_SECRET, { expiresIn: '10m' });

    // ✅ URL frontend de verificación
    const verification_link = `${process.env.FRONTEND_URL}/auth/verify-email?token=${token_verificacion}`;

    console.log("🌐 Enlace de verificación:", verification_link);

    await pool.query(
      `INSERT INTO users (uid, email, password, role, owner_name, telefono, created_at, verificado, token_verificacion)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), false, $7)`,
      [uid, email, password_hash, 'admin', owner_name, telefono, token_verificacion]
    );

    // ✅ Usar plantilla multilenguaje desde mailer.ts
    await sendVerificationEmail(email, verification_link, 'es'); // o 'en'

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('❌ Error en registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get("/verify-email", async (req: Request, res: Response) => {
  const token = req.query.token as string;

  if (!token) {
    return res.status(400).json({ error: "Token faltante" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { uid: string; email: string };

    const userRes = await pool.query("SELECT * FROM users WHERE uid = $1", [decoded.uid]);
    const user = userRes.rows[0];

    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    if (user.verificado) return res.status(400).json({ error: "La cuenta ya está verificada" });

    await pool.query(
      "UPDATE users SET verificado = true, token_verificacion = NULL WHERE uid = $1",
      [decoded.uid]
    );

    // ✅ Redireccionar al frontend
    const baseUrl = process.env.FRONTEND_URL || "https://www.aamy.ai";
    res.redirect(`${process.env.FRONTEND_URL}/auth/verify-email?token=${token}`);

  } catch (err) {
    console.error("❌ Error al verificar email:", err);
    return res.status(400).json({ error: "Token inválido o expirado" });
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

    const token = jwt.sign(
      {
        uid: user.uid,
        email: user.email,
        tenant_id: user.tenant_id || user.uid, // 👈 usa el uid como tenant_id si no hay campo separado
      },
      JWT_SECRET,
      {
        expiresIn: '7d',
      }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true, // 👈 esto es lo único nuevo
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({ uid: user.uid });
  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/debug-token', (req: Request, res: Response) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: '❌ No hay token en las cookies' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
    return res.status(200).json({ ok: true, decoded });
  } catch (err) {
    console.error('❌ Token inválido o expirado:', err);
    return res.status(401).json({ error: '❌ Token inválido o expirado', details: err });
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
