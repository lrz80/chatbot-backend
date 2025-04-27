import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = express.Router();

// 📥 Obtener mensajes de seguimiento ya enviados
router.get('/', authenticateUser, async (req, res) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const { rows: mensajes } = await pool.query(
      `SELECT id, contacto, contenido, fecha_envio
       FROM mensajes_programados
       WHERE tenant_id = $1 AND enviado = true
       ORDER BY fecha_envio DESC
       LIMIT 100`,
      [tenant_id]
    );

    res.status(200).json(mensajes);
  } catch (error) {
    console.error('❌ Error en GET /follow-up/sent-messages:', error);
    res.status(500).json({ error: 'Error al obtener mensajes enviados' });
  }
});

export default router;
