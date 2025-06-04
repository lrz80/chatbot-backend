import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const canal = req.query.canal?.toString() || "";
    const limit = parseInt(req.query.limit as string) || 10;
    const page = parseInt(req.query.page as string) || 1;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        m.id, m.tenant_id, m.content, m.sender, m.canal, m.timestamp, m.from_number, m.emotion,
        s.intencion, s.nivel_interes
      FROM messages m
      LEFT JOIN sales_intelligence s
        ON m.tenant_id = s.tenant_id AND m.message_id = s.message_id
      WHERE m.tenant_id = $1
    `;

    const values: any[] = [tenant_id];

    if (canal) {
      query += ` AND m.canal = $2`;
      values.push(canal);
    }

    // Ajuste para contar bien los placeholders si se usa canal o no
    const limitPlaceholder = `$${values.length + 1}`;
    const offsetPlaceholder = `$${values.length + 2}`;

    query += `
      ORDER BY m.timestamp DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `;
    values.push(limit, offset);

    const mensajesRes = await pool.query(query, values);

    res.status(200).json({ mensajes: mensajesRes.rows });
  } catch (error) {
    console.error("❌ Error al obtener historial:", error);
    res.status(500).json({ error: "Error al obtener mensajes" });
  }
});

export default router;
