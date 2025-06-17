import express from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

router.post('/', authenticateUser, async (req, res) => {
  const tenantId = req.user?.tenant_id;
  const { id } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT pregunta, respuesta_sugerida, canal
       FROM faq_sugeridas
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    const faq = rows[0];
    if (!faq) return res.status(404).json({ error: 'FAQ no encontrada' });

    const respuestaFinal = req.body.respuesta_editada || faq.respuesta_sugerida;

    await pool.query(
      `INSERT INTO faqs (tenant_id, pregunta, respuesta, canal)
      VALUES ($1, $2, $3, $4)`,
      [tenantId, faq.pregunta, respuestaFinal, faq.canal]
    );

    // Marcar sugerencia como aceptada
    await pool.query(
      `DELETE FROM faq_sugeridas WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error aprobando FAQ:', err);
    res.status(500).json({ error: 'Error al aprobar sugerencia' });
  }
});

export default router;
