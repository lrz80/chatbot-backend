import express from 'express';
import pool from '../../lib/db';
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT canal, COUNT(DISTINCT message_id) as total
      FROM messages
      GROUP BY canal
    `);

    // Normaliza y estructura la respuesta
    const conteo: Record<string, number> = {
        whatsapp: 0,
        facebook: 0,
        instagram: 0,
        voice: 0,
      };      

    for (const row of rows) {
      const canal = (row.canal || '').toLowerCase().trim();
      if (conteo[canal] !== undefined) {
        conteo[canal] = parseInt(row.total);
      }
    }

    res.json(conteo);
  } catch (err) {
    console.error('❌ Error al obtener conteo global:', err);
    res.status(500).json({ error: 'Error al obtener conteo' });
  }
});

export default router;
