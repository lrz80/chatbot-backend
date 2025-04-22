import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    // Buscar el tenant_id del usuario
    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [uid]);
    const user = userRes.rows[0];

    if (!user?.tenant_id) {
      return res.status(404).json({ error: 'Usuario sin tenant asociado' });
    }

    const tenant_id = user.tenant_id;
    const {
      idioma,
      canal,
      system_prompt,
      welcome_message,
      voice_name,
      voice_hints
    } = req.body;

    if (!canal || !idioma) {
      return res.status(400).json({ error: 'Faltan datos requeridos (idioma o canal).' });
    }

    const existing = await pool.query(
      'SELECT * FROM prompts WHERE tenant_id = $1 AND canal = $2 AND idioma = $3',
      [tenant_id, canal, idioma]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE prompts
         SET system_prompt = $1, welcome_message = $2, voice_name = $3, voice_hints = $4, created_at = NOW()
         WHERE tenant_id = $5 AND canal = $6 AND idioma = $7`,
        [system_prompt, welcome_message, voice_name, voice_hints, tenant_id, canal, idioma]
      );
    } else {
      await pool.query(
        `INSERT INTO prompts
         (tenant_id, canal, idioma, system_prompt, welcome_message, voice_name, voice_hints, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [tenant_id, canal, idioma, system_prompt, welcome_message, voice_name, voice_hints]
      );
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error en /api/voice-config:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

export default router;
