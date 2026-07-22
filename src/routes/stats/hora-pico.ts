// src/routes/stats/hora-pico.ts

import express, { Response } from "express";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../../middleware/auth";
import pool from "../../lib/db";

const router = express.Router();

// ⏰ Hora pico de mayor interacción durante los últimos 7 días
router.get(
  "/",
  authenticateUser,
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: "Tenant no disponible",
      });
    }

    try {
      const result = await pool.query(
        `
          SELECT
            EXTRACT(HOUR FROM timestamp)::int AS hora,
            COUNT(*)::int AS cantidad
          FROM messages
          WHERE tenant_id = $1
            AND role = 'user'
            AND canal IN (
              'whatsapp',
              'facebook',
              'instagram',
              'voice',
              'voz'
            )
            AND timestamp >= NOW() - INTERVAL '7 days'
          GROUP BY EXTRACT(HOUR FROM timestamp)
          ORDER BY cantidad DESC, hora ASC
          LIMIT 1
        `,
        [tenantId]
      );

      const row = result.rows[0];

      if (!row) {
        return res.status(200).json({
          hora_pico: null,
          cantidad: 0,
        });
      }

      return res.status(200).json({
        hora_pico: Number(row.hora),
        cantidad: Number(row.cantidad),
      });
    } catch (error) {
      console.error(
        "❌ Error al obtener hora pico:",
        {
          tenantId,
          error,
        }
      );

      return res.status(500).json({
        error: "Error al obtener datos",
      });
    }
  }
);

export default router;