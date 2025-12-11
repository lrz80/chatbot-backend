// src/routes/appointments.ts
import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = express.Router();

/**
 * GET /api/appointments
 * Lista las citas del tenant autenticado (últimas 50, ordenadas por fecha).
 */
router.get(
  "/",
  authenticateUser,
  async (
    req: Request & {
      user?: { uid: string; tenant_id: string; email?: string };
    },
    res: Response
  ) => {
    try {
      const user = req.user;

      if (!user?.tenant_id) {
        return res.status(401).json({
          ok: false,
          error: "TENANT_NOT_FOUND_IN_TOKEN",
        });
      }

      const tenantId = user.tenant_id;

      const { rows } = await pool.query(
        `
        SELECT
          a.id,
          a.tenant_id,
          a.service_id,
          s.name AS service_name,
          a.channel,
          a.customer_name,
          a.customer_phone,
          a.customer_email,
          a.start_time,
          a.end_time,
          a.status,
          a.created_at,
          a.updated_at
        FROM appointments a
        LEFT JOIN services s ON s.id = a.service_id
        WHERE a.tenant_id = $1
        ORDER BY a.start_time DESC
        LIMIT 50
        `,
        [tenantId]
      );

      return res.json({
        ok: true,
        appointments: rows,
      });
    } catch (error) {
      console.error("[GET /api/appointments] Error:", error);
      return res.status(500).json({
        ok: false,
        error: "INTERNAL_SERVER_ERROR",
      });
    }
  }
);

export default router;
