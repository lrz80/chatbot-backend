// 📁 src/routes/tenants.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ✅ Crear tenant (negocio)
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const admin_uid = decoded.uid;

    const {
      name,
      categoria,
      idioma = 'es',
      prompt = 'Eres un asistente útil.',
    } = req.body;

    if (!name || !categoria) {
      return res.status(400).json({ error: 'Nombre y categoría son requeridos' });
    }

    const slug = name.toLowerCase().replace(/\s+/g, '-');

    // Verifica si el usuario ya tiene un tenant
    const existing = await pool.query(
      'SELECT * FROM tenants WHERE admin_uid = $1',
      [admin_uid]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'El negocio ya existe' });
    }

    await pool.query(
      `INSERT INTO tenants (
        name, slug, admin_uid, categoria, idioma, prompt, bienvenida, 
        membresia_activa, membresia_vigencia, onboarding_completado, limite_uso, used
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        true, NOW() + interval '30 days', true, 150, 0
      )`,
      [
        name,
        slug,
        admin_uid,
        categoria,
        idioma,
        prompt,
        '¡Hola! 👋 Soy tu asistente virtual. ¿En qué puedo ayudarte?',
      ]
    );

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('❌ Error en /api/tenants:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
