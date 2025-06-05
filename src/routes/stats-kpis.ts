// src/routes/stats/kpis.ts
import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/kpis', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  const canal = req.query.canal as string | undefined;

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenant_id = decoded.tenant_id;
    if (!tenant_id) return res.status(404).json({ error: 'Tenant no encontrado' });

    const canalFilter = canal ? `AND canal = '${canal}'` : '';

    // 🧠 Mensajes únicos por message_id (evita duplicados por canal)
    const generalStats = await pool.query(
      `SELECT COUNT(DISTINCT message_id)::int AS total,
              COUNT(DISTINCT from_number)::int AS unicos
       FROM messages
       WHERE tenant_id = $1 AND sender IN ('user', 'bot') ${canalFilter}`,
      [tenant_id]
    );

    const horaPicoRes = await pool.query(
      `SELECT EXTRACT(HOUR FROM timestamp)::int AS hora,
              COUNT(DISTINCT message_id) AS total
       FROM messages
       WHERE tenant_id = $1
         AND sender = 'user'
         AND canal IN ('whatsapp', 'facebook', 'instagram', 'voz')
         AND timestamp >= NOW() - INTERVAL '7 days'
       GROUP BY hora
       ORDER BY total DESC
       LIMIT 1`,
      [tenant_id]
    );    

    const ventasRes = await pool.query(
      `SELECT COUNT(DISTINCT message_id)::int AS intenciones
       FROM sales_intelligence
       WHERE tenant_id = $1 ${canalFilter}
         AND LOWER(intencion) IN ('comprar', 'pagar', 'precio', 'reservar', 'agendar', 'confirmar', 'suscribirme')
         AND nivel_interes >= 2`,
      [tenant_id]
    );    

    const total = generalStats.rows[0]?.total || 0;
    const unicos = generalStats.rows[0]?.unicos || 0;
    const hora_pico = horaPicoRes.rows[0]?.hora || null;
    const intenciones_venta = ventasRes.rows[0]?.intenciones || 0;

    return res.status(200).json({ total, unicos, hora_pico, intenciones_venta });
  } catch (error) {
    console.error('❌ Error en /api/stats/kpis:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
