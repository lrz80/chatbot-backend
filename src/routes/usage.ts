// src/routes/usage.ts
import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

const CANALES = [
  { canal: 'whatsapp', limite: 500 },
  { canal: 'meta', limite: 500 }, // Incluye meta correctamente
  { canal: 'followup', limite: 500 },
  { canal: 'voz', limite: 50000 },
  { canal: 'sms', limite: 500 },
  { canal: 'email', limite: 2000 },
  { canal: 'tokens_openai', limite: null },
  { canal: 'almacenamiento', limite: 5120 },
  { canal: 'contactos', limite: 500 },
];

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user?.tenant_id) return res.status(404).json({ error: 'Usuario sin tenant asociado' });

    const tenantId = user.tenant_id;

    // 🔥 Cambiamos la consulta para usar el mes actual, no membresia_inicio
    const usoRes = await pool.query(`
      SELECT canal, SUM(usados) as usados
      FROM uso_mensual
      WHERE tenant_id = $1 AND mes = date_trunc('month', CURRENT_DATE)
      GROUP BY canal
    `, [tenantId]);

    // 🔍 Obtener créditos extra válidos (no vencidos)
    const creditosRes = await pool.query(`
      SELECT canal, COALESCE(SUM(cantidad), 0) as total
      FROM creditos_comprados
      WHERE tenant_id = $1 AND fecha_vencimiento >= NOW()
      GROUP BY canal
    `, [tenantId]);

    const creditosMap = new Map(creditosRes.rows.map((row: any) => [row.canal, parseInt(row.total)]));
    const usosMap = new Map(usoRes.rows.map((row: any) => [row.canal, parseInt(row.usados)]));

    const usos = CANALES.map(({ canal, limite: limiteBase }) => {
      const usados = usosMap.get(canal) ?? 0;
      const creditosExtras = creditosMap.get(canal) ?? 0;
      const totalLimite = (limiteBase ?? 0) + creditosExtras;

      const porcentaje = totalLimite > 0 ? (usados / totalLimite) * 100 : 0;

      let notificar = null;
      if (totalLimite) {
        if (porcentaje >= 100) notificar = 'limite';
        else if (porcentaje >= 80) notificar = 'aviso';
      }

      return {
        canal,
        usados,
        limite: totalLimite,
        porcentaje,
        notificar
      };
    });

    return res.status(200).json({ usos, plan: 'custom' });

  } catch (error) {
    console.error('❌ Error en /usage:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
