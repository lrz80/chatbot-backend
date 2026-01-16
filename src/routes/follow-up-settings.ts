import express from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = express.Router();

// 📥 GET: Obtener configuración de seguimiento
router.get('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  try {
    // Obtenemos configuración de seguimiento
    const result = await pool.query(
      `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
      [tenant_id]
    );

    // Obtenemos membresia_activa del tenant
    const tenantResult = await pool.query(
      `SELECT membresia_activa FROM tenants WHERE id = $1`,
      [tenant_id]
    );

    const membresiaActiva = tenantResult.rows[0]?.membresia_activa ?? false;

    if (result.rows.length === 0) {
      return res.json({
        minutos_espera: null,
        mensaje_precio: '',
        mensaje_agendar: '',
        mensaje_ubicacion: '',
        mensaje_general: '',
        membresia_activa: membresiaActiva,  // 🔥 Aquí se incluye
      });
    }

    res.json({
      ...result.rows[0],
      membresia_activa: membresiaActiva,  // 🔥 Aquí también
    });

  } catch (error) {
    console.error('❌ Error obteniendo follow_up_settings:', error);
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// 🛠 POST: Crear o actualizar configuración de seguimiento
router.post('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;
  const {
    minutos_espera,
    mensaje_precio,
    mensaje_agendar,
    mensaje_ubicacion,
    mensaje_general,
  } = req.body;

  try {
    const existing = await pool.query(
      `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
      [tenant_id]
    );

    if (existing.rows.length > 0) {
      // Ya existe: hacer UPDATE
      await pool.query(
        `UPDATE follow_up_settings SET
          minutos_espera = $1,
          mensaje_precio = $2,
          mensaje_agendar = $3,
          mensaje_ubicacion = $4,
          mensaje_general = $5
         WHERE tenant_id = $6`,
        [
          minutos_espera,
          mensaje_precio,
          mensaje_agendar,
          mensaje_ubicacion,
          mensaje_general,
          tenant_id
        ]
      );
    } else {
      // No existe: hacer INSERT
      await pool.query(
        `INSERT INTO follow_up_settings (
          tenant_id, minutos_espera, mensaje_precio, mensaje_agendar, mensaje_ubicacion, mensaje_general
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenant_id,
          minutos_espera,
          mensaje_precio,
          mensaje_agendar,
          mensaje_ubicacion,
          mensaje_general,
        ]
      );
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error guardando follow_up_settings:', error);
    res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

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
      // ✅ defaults nuevos por nivel (y legacy vacíos para compat)
      return res.json({
        minutos_espera: 60,
        mensaje_nivel_bajo: '',
        mensaje_nivel_medio: '',
        mensaje_nivel_alto: '',

        // legacy (por si algo aún lo lee)
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
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// 🛠 POST: Crear o actualizar configuración de seguimiento (por niveles)
router.post('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  const {
    minutos_espera,

    // ✅ nuevos por nivel (lo que tu UI envía)
    mensaje_nivel_bajo,
    mensaje_nivel_medio,
    mensaje_nivel_alto,

    // legacy (por si algún cliente viejo todavía guarda)
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

          -- ✅ nuevos
          mensaje_nivel_bajo  = COALESCE($2, mensaje_nivel_bajo),
          mensaje_nivel_medio = COALESCE($3, mensaje_nivel_medio),
          mensaje_nivel_alto  = COALESCE($4, mensaje_nivel_alto),

          -- legacy (solo si llegan)
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

          -- ✅ nuevos
          mensaje_nivel_bajo,
          mensaje_nivel_medio,
          mensaje_nivel_alto,

          -- legacy
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

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error guardando follow_up_settings:', error);
    res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

export default router;
