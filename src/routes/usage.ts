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
  { canal: 'voz', limite: 50000 }, // 🔥 50,000 tokens GPT-4
  { canal: 'sms', limite: 500 },
  { canal: 'email', limite: 2000 },
  { canal: 'tokens_openai', limite: null }, // 📝 Solo para métricas, no bloquea
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
    const mesActual = new Date().toISOString().substring(0, 7) + '-01';

    // 📝 Preparamos inserción o actualización del límite por canal
    for (const { canal, limite } of CANALES) {
      await pool.query(`
        INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
        VALUES ($1, $2, $3, 0, $4)
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET limite = EXCLUDED.limite
      `, [tenantId, canal, mesActual, limite]);
    }

    // 🔍 Obtenemos todos los registros de uso
    const usoRes = await pool.query(`
      SELECT canal, usados, limite
      FROM uso_mensual
      WHERE tenant_id = $1 AND mes = $2
    `, [tenantId, mesActual]);

    // 📨 Calculamos notificación para cada canal
    const usos = usoRes.rows.map((row: any) => {
      const porcentaje = row.limite ? (row.usados / row.limite) * 100 : 0;
      const notificar = row.limite
        ? porcentaje >= 80
          ? porcentaje >= 100
            ? 'limite'
            : 'aviso'
          : null
        : null; // tokens_openai nunca bloquea

      return {
        ...row,
        porcentaje,
        notificar, // Puede ser 'aviso', 'limite' o null
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
