import express from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';
import { detectarIntencion } from '../../lib/detectarIntencion';

const router = express.Router();

router.post('/', authenticateUser, async (req, res) => {
  const tenantId = req.user?.tenant_id;
  const { id, respuesta_editada } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT pregunta, respuesta_sugerida, canal
       FROM faq_sugeridas
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    const faq = rows[0];
    if (!faq) return res.status(404).json({ error: 'FAQ no encontrada' });

    const { intencion } = await detectarIntencion(faq.pregunta);
    const intencionFinal = intencion.trim().toLowerCase();
    const respuestaFinal = respuesta_editada || faq.respuesta_sugerida;

    // ✅ Expandir canal "meta" como ["facebook", "instagram"]
    const canalesComparar = faq.canal === 'meta' ? ['facebook', 'instagram'] : [faq.canal];

    // Validar que no exista ya una FAQ con esa intención
    const { rows: existentes } = await pool.query(
      `SELECT 1 FROM faqs WHERE tenant_id = $1 AND canal = ANY($2) AND intencion = $3 LIMIT 1`,
      [tenantId, canalesComparar, intencionFinal]
    );    

    if (existentes.length > 0) {
      return res.status(409).json({ error: 'Ya existe una FAQ con esa intención para este canal' });
    }

    const canalFinal = (faq.canal === 'facebook' || faq.canal === 'instagram') ? 'meta' : faq.canal;

    // Insertar FAQ aprobada
    await pool.query(
      `INSERT INTO faqs (tenant_id, pregunta, respuesta, canal, intencion)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, faq.pregunta, respuestaFinal, canalFinal, intencionFinal]
    );    

    // Eliminar sugerencia aceptada
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