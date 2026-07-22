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
              DATE(created_at) AS dia,
              COUNT(*)::int AS count
            FROM interactions
            WHERE tenant_id = $1
              AND created_at >= date_trunc('month', CURRENT_DATE)
            GROUP BY DATE(created_at)
            ORDER BY dia
          `
          : `
            SELECT
              TO_CHAR(created_at, 'YYYY-MM') AS mes,
              COUNT(*)::int AS count
            FROM interactions
            WHERE tenant_id = $1
            GROUP BY TO_CHAR(created_at, 'YYYY-MM')
            ORDER BY mes
          `;

      const result = await pool.query(query, [
        tenantId,
      ]);

      return res.status(200).json(result.rows);
    } catch (error) {
      console.error(
        "❌ Error en /stats/monthly:",
        {
          tenantId,
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