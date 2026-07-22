// src/routes/stats/interacciones-por-dia.ts

import express, { Response } from "express";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../../middleware/auth";
import pool from "../../lib/db";

const router = express.Router();

// 📊 Obtener interacciones por día de los últimos 7 días
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
            DATE(timestamp) AS dia,
            COUNT(*)::int AS count
          FROM messages
          WHERE tenant_id = $1
            AND role = 'user'
            AND timestamp >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(timestamp)
          ORDER BY dia ASC
        `,
        [tenantId]
      );

      return res.status(200).json(result.rows);
    } catch (error) {
      console.error(
        "❌ Error al obtener interacciones por día:",
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