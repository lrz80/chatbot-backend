import express from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = express.Router();

// 📥 GET: Obtener configuración de seguimiento (por niveles)
router.get('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  try {
    const result = await pool.query(
      `SELECT *
         FROM follow_up_settings
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenant_id]
    );

    const tenantResult = await pool.query(
      `SELECT membresia_activa FROM tenants WHERE id = $1`,
      [tenant_id]
    );

    const membresiaActiva = tenantResult.rows[0]?.membresia_activa ?? false;

    if (result.rows.length === 0) {
      return res.json({
        minutos_espera: 60,

        // ✅ nuevos por nivel
        mensaje_nivel_bajo: '',
        mensaje_nivel_medio: '',
        mensaje_nivel_alto: '',

        // legacy (compatibilidad)
        mensaje_precio: '',
        mensaje_agendar: '',
        mensaje_ubicacion: '',
        mensaje_general: '',

        membresia_activa: membresiaActiva,
      });
    }

    return res.json({
      ...result.rows[0],
      membresia_activa: membresiaActiva,
    });
  } catch (error) {
    console.error('❌ Error obteniendo follow_up_settings:', error);
    return res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// 🛠 POST: Crear o actualizar configuración de seguimiento (por niveles)
router.post('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  const {
    minutos_espera,

    // ✅ nuevos por nivel
    mensaje_nivel_bajo,
    mensaje_nivel_medio,
    mensaje_nivel_alto,

    // legacy
    mensaje_precio,
    mensaje_agendar,
    mensaje_ubicacion,
    mensaje_general,
  } = req.body;

  try {
    const existing = await pool.query(
      `SELECT 1 FROM follow_up_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenant_id]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE follow_up_settings SET
          minutos_espera = COALESCE($1, minutos_espera),

          mensaje_nivel_bajo  = COALESCE($2, mensaje_nivel_bajo),
          mensaje_nivel_medio = COALESCE($3, mensaje_nivel_medio),
          mensaje_nivel_alto  = COALESCE($4, mensaje_nivel_alto),

          mensaje_precio    = COALESCE($5, mensaje_precio),
          mensaje_agendar   = COALESCE($6, mensaje_agendar),
          mensaje_ubicacion = COALESCE($7, mensaje_ubicacion),
          mensaje_general   = COALESCE($8, mensaje_general),

          updated_at = NOW()
         WHERE tenant_id = $9`,
        [
          minutos_espera ?? null,

          mensaje_nivel_bajo ?? null,
          mensaje_nivel_medio ?? null,
          mensaje_nivel_alto ?? null,

          mensaje_precio ?? null,
          mensaje_agendar ?? null,
          mensaje_ubicacion ?? null,
          mensaje_general ?? null,

          tenant_id,
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO follow_up_settings (
          tenant_id,
          minutos_espera,
          mensaje_nivel_bajo,
          mensaje_nivel_medio,
          mensaje_nivel_alto,
          mensaje_precio,
          mensaje_agendar,
          mensaje_ubicacion,
          mensaje_general,
          created_at,
          updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
        [
          tenant_id,
          minutos_espera ?? 60,

          mensaje_nivel_bajo ?? '',
          mensaje_nivel_medio ?? '',
          mensaje_nivel_alto ?? '',

          mensaje_precio ?? '',
          mensaje_agendar ?? '',
          mensaje_ubicacion ?? '',
          mensaje_general ?? '',
        ]
      );
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error guardando follow_up_settings:', error);
    return res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

export default router;
