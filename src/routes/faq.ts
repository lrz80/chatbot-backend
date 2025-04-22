// src/routes/faq.ts
import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

const router = Router();

// ✅ GET: Obtener FAQs
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    const faqRes = await pool.query(
      'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1',
      [tenantId]
    );

    return res.status(200).json(faqRes.rows);
  } catch (err) {
    console.error('❌ Error al obtener FAQ:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ✅ POST: Guardar FAQs
router.post('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    const { faqs } = req.body;

    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    await pool.query('DELETE FROM faqs WHERE tenant_id = $1', [tenantId]);

    for (const item of faqs) {
      await pool.query(
        'INSERT INTO faqs (tenant_id, pregunta, respuesta) VALUES ($1, $2, $3)',
        [tenantId, item.pregunta, item.respuesta]
      );
    }

    return res.status(200).json({ message: 'FAQs actualizadas' });
  } catch (err) {
    console.error('❌ Error al guardar FAQ:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
