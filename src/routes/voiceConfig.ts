// 📁 src/routes/voiceConfig.ts

import { Router, Request, Response } from 'express';
import pool from '../lib/db';

const router: Router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      tenant_id,
      idioma,
      canal,
      system_prompt,
      welcome_message,
      voice_name,
      voice_hints
    } = req.body;

    if (!tenant_id || !canal) {
      return res.status(400).json({ error: 'Faltan datos requeridos (tenant_id o canal).' });
    }

    // Verificar si ya existe una configuración para este tenant, canal e idioma
    const existing = await pool.query(
      'SELECT * FROM prompts WHERE tenant_id = $1 AND canal = $2 AND idioma = $3',
      [tenant_id, canal, idioma]
    );

    if (existing.rows.length > 0) {
      // Actualizar configuración existente
      await pool.query(
        `UPDATE prompts
         SET system_prompt = $1, welcome_message = $2, voice_name = $3, voice_hints = $4, created_at = NOW()
         WHERE tenant_id = $5 AND canal = $6 AND idioma = $7`,
        [system_prompt, welcome_message, voice_name, voice_hints, tenant_id, canal, idioma]
      );
    } else {
      // Insertar nueva configuración
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
