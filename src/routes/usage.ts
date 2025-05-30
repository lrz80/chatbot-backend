import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ✅ Definimos los canales con límites para mostrar en la interfaz
const CANALES = [
  { canal: 'whatsapp', limite: 500 },
  { canal: 'meta', limite: 500 },
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

    // 🔎 Obtener fecha de inicio de membresía del tenant
    const tenantRes = await pool.query('SELECT membresia_inicio FROM tenants WHERE id = $1', [tenantId]);
    const membresiaInicio = tenantRes.rows[0]?.membresia_inicio;
    if (!membresiaInicio) return res.status(400).json({ error: 'Tenant sin fecha de membresía' });

    const inicio = new Date(membresiaInicio);
    const hoy = new Date();

    // 🔍 Obtenemos todos los registros de uso dentro del ciclo de membresía
    const usoRes = await pool.query(`
      SELECT canal, usados, limite
      FROM uso_mensual
      WHERE tenant_id = $1 AND mes >= $2
    `, [tenantId, inicio.toISOString().substring(0, 10)]); // YYYY-MM-DD

    // 📝 Preparamos inserción o actualización del límite por canal
    for (const { canal, limite } of CANALES) {
      await pool.query(`
        INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
        VALUES ($1, $2, $3, 0, $4)
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET limite = EXCLUDED.limite
      `, [tenantId, canal, inicio.toISOString().substring(0, 10), limite]);
    }

    // 📨 Calculamos notificación para cada canal
    const usos = usoRes.rows.map((row: any) => {
      const porcentaje = row.limite ? (row.usados / row.limite) * 100 : 0;
      const notificar = row.limite
        ? porcentaje >= 80
          ? porcentaje >= 100
            ? 'limite'
            : 'aviso'
          : null
        : null;

      return {
        ...row,
        porcentaje,
        notificar,
      };
    });

    return res.status(200).json({
      usos,
      plan: "custom",
    });

  } catch (error) {
    console.error('❌ Error en /usage:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
