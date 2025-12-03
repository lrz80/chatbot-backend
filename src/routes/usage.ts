// src/routes/usage.ts
import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';
import { cycleStartForNow } from '../utils/billingCycle';
import { getLimitesPorPlan } from '../lib/usageLimits';


const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user?.tenant_id) return res.status(404).json({ error: 'Usuario sin tenant asociado' });

    const tenantId = user.tenant_id;

    // 🔍 Obtenemos membresia_inicio del tenant
    const tenantRes = await pool.query(
      'SELECT membresia_inicio, plan FROM tenants WHERE id = $1',
      [tenantId]
    );
    const tenantRow = tenantRes.rows[0];
    const membresiaInicio = tenantRow?.membresia_inicio;
    const tenantPlan = tenantRow?.plan || 'starter';

    if (!membresiaInicio) {
      return res.status(400).json({ error: 'Membresía no configurada' });
    }

    const limites = getLimitesPorPlan(tenantPlan);

    // 🔁 mismo cálculo que el webhook
    const ciclo = cycleStartForNow(membresiaInicio);

    const usoRes = await pool.query(
      `
        SELECT 
          CASE 
            WHEN canal IN ('facebook', 'instagram') THEN 'meta'
            ELSE canal
          END as canal,
          SUM(usados) as usados
        FROM uso_mensual
        WHERE tenant_id = $1 AND mes = $2::date
        GROUP BY 1
      `,
      [tenantId, ciclo]
    );

    // 🔍 Obtener créditos extra válidos (no vencidos)
    const creditosRes = await pool.query(`
      SELECT canal, COALESCE(SUM(cantidad), 0) as total
      FROM creditos_comprados
      WHERE tenant_id = $1 AND fecha_vencimiento >= NOW()
      GROUP BY canal
    `, [tenantId]);

    const creditosMap = new Map(
      creditosRes.rows.map((row: any) => [row.canal, parseInt(row.total, 10)])
    );
    const usosMap = new Map(
      usoRes.rows.map((row: any) => [row.canal, parseInt(row.usados, 10)])
    );

    // limites viene de getLimitesPorPlan(tenantPlan)
    const usos = Object.entries(limites).map(([canal, limiteBase]) => {
      const usados = usosMap.get(canal) ?? 0;
      const creditosExtras = creditosMap.get(canal) ?? 0;
      const totalLimite = (limiteBase ?? 0) + creditosExtras;

      const porcentaje = totalLimite > 0 ? (usados / totalLimite) * 100 : 0;

      let notificar: 'aviso' | 'limite' | null = null;
      if (totalLimite) {
        if (porcentaje >= 100) notificar = 'limite';
        else if (porcentaje >= 80) notificar = 'aviso';
      }

      return {
        canal,
        usados,
        limite: totalLimite,
        limite_base: limiteBase ?? 0,      // 👈 base del plan
        creditos_extras: creditosExtras,   // 👈 de la tabla creditos_comprados
        porcentaje,
        notificar,
      };
    });

    return res.status(200).json({ usos, plan: tenantPlan });

  } catch (error) {
    console.error('❌ Error en /usage:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
