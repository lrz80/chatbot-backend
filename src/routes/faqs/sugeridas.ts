// src/routes/faqs/sugeridas.ts
import express from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

router.get('/', authenticateUser, async (req, res) => {
  const tenantId = req.user?.tenant_id;
  const canalQuery = req.query.canal;

  let canales = Array.isArray(canalQuery)
    ? canalQuery.map(c => c.toString())
    : [canalQuery?.toString() || 'whatsapp'];

  // 🔁 Si llega 'meta', expandimos pero mantenemos 'meta'
if (canales.includes('meta')) {
  canales = canales.filter(c => c !== 'meta');
  canales.push('meta', 'facebook', 'instagram'); // <- agrega 'meta'
}

  try {
    const { rows } = await pool.query(
      `SELECT id, pregunta, respuesta_sugerida, canal
       FROM faq_sugeridas
       WHERE tenant_id = $1
         AND canal = ANY($2)
         AND procesada = false
         AND respuesta_sugerida IS NOT NULL
       ORDER BY ultima_fecha DESC`,
      [tenantId, canales]
    );

    res.json(rows);
  } catch (err) {
    console.error('❌ Error cargando FAQ sugeridas:', err);
    res.status(500).json({ error: 'Error al cargar sugerencias' });
  }
});

export default router;
