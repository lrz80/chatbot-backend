import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// GET: Obtener FAQs
router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const tenantRes = await pool.query('SELECT id FROM tenants WHERE admin_uid = $1', [decoded.uid]);
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    const faqRes = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenantId]);
    return res.status(200).json(faqRes.rows);
  } catch (err) {
    console.error('❌ Error al obtener FAQ:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// POST: Guardar FAQs
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const { faqs } = req.body;

    const tenantRes = await pool.query('SELECT id FROM tenants WHERE admin_uid = $1', [decoded.uid]);
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Limpiar anteriores
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
