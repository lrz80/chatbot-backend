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
      membresia_activa: tenant?.membresia_activa ?? false,
      membresia_vigencia: tenant?.membresia_vigencia ?? null,
      negocio: tenant
        ? {
            tenant_id: tenant.id,
            nombre_negocio: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
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

// POST: Actualizar perfil del negocio
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const { name, categoria, idioma, direccion, horario_atencion, prompt, bienvenida } = req.body;

    // Verificar si el usuario existe
    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Verificar si el tenant existe
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [user.uid]);
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    // Actualizar el tenant
    await pool.query(
      `UPDATE tenants SET 
        name = $1,
        categoria = $2,
        idioma = $3,
        direccion = $4,
        horario_atencion = $5,
        prompt = $6,
        bienvenida = $7
      WHERE admin_uid = $8`,
      [name, categoria, idioma, direccion, horario_atencion, prompt, bienvenida, user.uid]
    );

    return res.status(200).json({ message: 'Perfil actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error al actualizar perfil:', error);
    return res.status(500).json({ error: 'Error al guardar cambios' });
  }
});

export default router;
