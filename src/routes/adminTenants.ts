// src/routes/adminTenants.ts

import express, { Response } from "express";
import pool from "../lib/db";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../middleware/auth";

const router = express.Router();

const isProduction = process.env.NODE_ENV === "production";

const adminTenantCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction
    ? ("none" as const)
    : ("lax" as const),
  path: "/",
  maxAge: 1000 * 60 * 60 * 24 * 30,
};

function requireAdmin(
  req: AuthenticatedRequest,
  res: Response
): boolean {
  if (!req.user?.is_admin) {
    res.status(403).json({
      error: "Acceso exclusivo para administradores",
    });

    return false;
  }

  return true;
}

/**
 * Lista todos los tenants disponibles.
 */
router.get(
  "/",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    try {
      const result = await pool.query(
        `
          SELECT
            id,
            name,
            logo_url,
            email_negocio,
            telefono_negocio,
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
        selected_tenant_id: req.user?.tenant_id,
        home_tenant_id: req.user?.home_tenant_id,
      });
    } catch (error) {
      console.error(
        "❌ GET /api/admin/tenants:",
        error
      );

      return res.status(500).json({
        error: "No se pudieron cargar los tenants",
      });
    }
  }
);

/**
 * Selecciona el tenant que el administrador desea manejar.
 */
router.post(
  "/select",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    try {
      const tenantId =
        typeof req.body?.tenant_id === "string"
          ? req.body.tenant_id.trim()
          : "";

      if (!tenantId) {
        return res.status(400).json({
          error: "tenant_id es requerido",
        });
      }

      const tenantResult = await pool.query(
        `
          SELECT
            id,
            name,
            logo_url
          FROM tenants
          WHERE id = $1
          LIMIT 1
        `,
        [tenantId]
      );

      const tenant = tenantResult.rows[0];

      if (!tenant) {
        return res.status(404).json({
          error: "Tenant no encontrado",
        });
      }

      res.cookie(
        "admin_tenant_id",
        tenant.id,
        adminTenantCookieOptions
      );

      return res.status(200).json({
        ok: true,
        tenant,
      });
    } catch (error) {
      console.error(
        "❌ POST /api/admin/tenants/select:",
        error
      );

      return res.status(500).json({
        error: "No se pudo seleccionar el tenant",
      });
    }
  }
);

/**
 * Regresa al tenant propio de la cuenta administrativa.
 */
router.delete(
  "/select",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    res.clearCookie("admin_tenant_id", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction
        ? "none"
        : "lax",
      path: "/",
    });

    return res.status(200).json({
      ok: true,
      tenant_id: req.user?.home_tenant_id,
    });
  }
);

export default router;