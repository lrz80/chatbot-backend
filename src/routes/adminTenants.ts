// src/routes/adminTenants.ts

import express, { Response } from "express";
import pool from "../lib/db";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../middleware/auth";

const router = express.Router();

router.get(
  "/",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.user?.role !== "admin") {
        return res.status(403).json({
          error: "Acceso exclusivo para administradores",
        });
      }

      const result = await pool.query(
        `
          SELECT
            id,
            name,
            email_negocio,
            telefono_negocio,
            logo_url,
            membresia_activa,
            es_trial,
            created_at
          FROM tenants
          ORDER BY
            LOWER(COALESCE(name, '')) ASC,
            created_at DESC
        `
      );

      return res.status(200).json({
        tenants: result.rows,
      });
    } catch (error) {
      console.error("❌ GET /api/admin/tenants error:", error);

      return res.status(500).json({
        error: "No se pudieron cargar los tenants",
      });
    }
  }
);

export default router;