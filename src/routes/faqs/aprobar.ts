import express from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { intencionSegura } from '../../utils/intent'; // 🆕 IMPORT

const router = express.Router();

router.post('/', authenticateUser, async (req, res) => {
  const tenantId = req.user?.tenant_id as string;
  if (!tenantId) {
    return res.status(401).json({ error: 'Tenant no encontrado' });
  }

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

    // Detecta intención base con tu modelo
    const { intencion } = await detectarIntencion(faq.pregunta, tenantId);

    // 🆕 Especializa la intención si es genérica (duda/consulta/pregunta)
    const intencionFinal = intencionSegura(intencion?.trim().toLowerCase() || '', faq.pregunta);

    const respuestaFinal = respuesta_editada || faq.respuesta_sugerida;

    // Para comparar, expande "meta" a ambos canales físicos
    const canalesComparar =
      faq.canal === 'meta' ? ['facebook', 'instagram'] : [faq.canal];

    // Evitar duplicado exacto de intención en esos canales
    const { rows: existentes } = await pool.query(
      `SELECT 1 
         FROM faqs 
        WHERE tenant_id = $1 
          AND canal = ANY($2) 
          AND intencion = $3 
        LIMIT 1`,
      [tenantId, canalesComparar, intencionFinal]
    );

    if (existentes.length > 0) {
      return res
        .status(409)
        .json({ error: 'Ya existe una FAQ con esa intención para este canal' });
    }

    // Guardamos canónicamente "meta" en lugar de fb/ig
    const canalFinal =
      faq.canal === 'facebook' || faq.canal === 'instagram'
        ? 'meta'
        : faq.canal;

    await pool.query(
      `INSERT INTO faqs (tenant_id, pregunta, respuesta, canal, intencion)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, faq.pregunta, respuestaFinal, canalFinal, intencionFinal]
    );

    await pool.query(`DELETE FROM faq_sugeridas WHERE id = $1`, [id]);

    // 🆕 Devuelve la intención final (útil para UI)
    res.json({ success: true, intencion: intencionFinal });
  } catch (err) {
    console.error('❌ Error aprobando FAQ:', err);
    res.status(500).json({ error: 'Error al aprobar sugerencia' });
  }
});

export default router;
