import express from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = express.Router();

// 📥 GET: Obtener configuración de seguimiento
router.get('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  try {
    const result = await pool.query(
      `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
      [tenant_id]
    );

    if (result.rows.length === 0) {
      return res.json(null); // No hay configuración todavía
    }

    res.json(result.rows[0]);
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

export default router;
