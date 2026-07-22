// src/routes/sales-intelligence/stats.ts

import express, { Response } from "express";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../../middleware/auth";
import pool from "../../lib/db";

const router = express.Router();

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
      const [totalRes, calientesRes] = await Promise.all([
        pool.query(
          `
            SELECT COUNT(*)::int AS total
            FROM sales_intelligence
            WHERE tenant_id = $1
              AND intencion IS NOT NULL
              AND LOWER(TRIM(intencion)) <> 'saludo'
          `,
          [tenantId]
        ),

        pool.query(
          `
            SELECT COUNT(*)::int AS total
            FROM sales_intelligence
            WHERE tenant_id = $1
              AND nivel_interes >= 4
          `,
          [tenantId]
        ),
      ]);

      return res.json({
        total_intenciones:
          Number(totalRes.rows[0]?.total) || 0,

        leads_calientes:
          Number(calientesRes.rows[0]?.total) || 0,
      });
    } catch (error) {
      console.error(
        "❌ Error en /sales-intelligence/stats:",
        {
          tenantId,
          error,
        }
      );

      return res.status(500).json({
        error: "Error al obtener estadísticas",
      });
    }
  }
);

export default router;