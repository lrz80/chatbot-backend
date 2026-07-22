// src/routes/stats-monthly.ts

import { Router, Response } from "express";
import pool from "../lib/db";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../middleware/auth";

const router = Router();

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

    const monthView =
      req.query.month === "current"
        ? "current"
        : "year";

    try {
      const query =
        monthView === "current"
          ? `
            SELECT
              DATE(timestamp) AS dia,
              COUNT(DISTINCT message_id)::int AS count
            FROM messages
            WHERE tenant_id = $1
              AND role IN ('user', 'assistant')
              AND timestamp >= date_trunc(
                'month',
                CURRENT_DATE
              )
            GROUP BY DATE(timestamp)
            ORDER BY dia ASC
          `
          : `
            SELECT
              TO_CHAR(
                timestamp,
                'YYYY-MM'
              ) AS mes,
              COUNT(
                DISTINCT message_id
              )::int AS count
            FROM messages
            WHERE tenant_id = $1
              AND role IN ('user', 'assistant')
              AND timestamp >= date_trunc(
                'year',
                CURRENT_DATE
              )
            GROUP BY TO_CHAR(
              timestamp,
              'YYYY-MM'
            )
            ORDER BY mes ASC
          `;

      const result = await pool.query(
        query,
        [tenantId]
      );

      return res.status(200).json(
        result.rows
      );
    } catch (error) {
      console.error(
        "❌ Error en /stats/monthly:",
        {
          tenantId,
          monthView,
          error,
        }
      );

      return res.status(500).json({
        error: "Error interno del servidor",
      });
    }
  }
);

export default router;