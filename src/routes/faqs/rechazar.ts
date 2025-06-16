// src/routes/faqs/rechazar.ts
import express from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

router.post('/', authenticateUser, async (req, res) => {
  const { id } = req.body;
  const tenantId = req.user?.tenant_id;

  try {
    await pool.query(`DELETE FROM faq_sugeridas WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error al eliminar sugerencia FAQ:', err);
    res.status(500).json({ error: 'Error al eliminar' });
  }
});

export default router;
