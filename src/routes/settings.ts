// 📁 src/routes/settings.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    // Obtener datos del usuario
    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Buscar tenant que le pertenece
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [user.uid]);
    const tenant = tenantRes.rows[0];

    // ✅ Si no tiene tenant, permite continuar pero con negocio = null
    return res.status(200).json({
      uid: user.uid,
      email: user.email,
      owner_name: user.owner_name,
      negocio: tenant
        ? {
            tenant_id: tenant.id,
            nombre_negocio: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            membresia_activa: tenant.membresia_activa,
            membresia_vigencia: tenant.membresia_vigencia,
            idioma: tenant.idioma,
            categoria: tenant.categoria,
            prompt: tenant.prompt,
            bienvenida: tenant.bienvenida,
            onboarding_completado: tenant.onboarding_completado,
            direccion: tenant.direccion,
            horario_atencion: tenant.horario_atencion,
          }
        : null,
    });
  } catch (error) {
    console.error('❌ Error en /api/settings:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

export default router;
