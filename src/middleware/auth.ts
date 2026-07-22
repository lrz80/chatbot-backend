// src/middleware/auth.ts

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import pool from "../lib/db";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const DEBUG_AUTH_LOGS = process.env.DEBUG_AUTH_LOGS === "true";

export type UserRole =
  | "admin"
  | "business_owner"
  | "manager"
  | "technician";

export interface AuthenticatedUser {
  uid: string;
  email?: string;

  role: UserRole;
  is_admin: boolean;

  /**
   * Tenant propio de la cuenta.
   */
  home_tenant_id: string;

  /**
   * Tenant que debe utilizar la petición.
   * Para admin puede ser el tenant seleccionado.
   */
  tenant_id: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

function normalizeRole(value: unknown): UserRole {
  switch (value) {
    case "admin":
    case "business_owner":
    case "manager":
    case "technician":
      return value;

    default:
      return "business_owner";
  }
}

function cleanTenantId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned || null;
}

export const authenticateUser = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  const rawAuthorization = req.headers.authorization ?? "";

  const headerToken = rawAuthorization
    .toLowerCase()
    .startsWith("bearer ")
    ? rawAuthorization.slice(7).trim()
    : undefined;

  const token = req.cookies?.token || headerToken;

  if (!token) {
    console.warn(
      `⚠️ [AUTH] Token requerido (${req.method} ${req.originalUrl})`
    );

    return res.status(401).json({
      error: "Token requerido",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      uid?: string;
      email?: string;
    };

    if (!decoded.uid) {
      return res.status(401).json({
        error: "Token sin usuario válido",
      });
    }

    const userResult = await pool.query(
      `
        SELECT
          uid,
          email,
          tenant_id,
          COALESCE(role, 'business_owner') AS role
        FROM users
        WHERE uid = $1
        LIMIT 1
      `,
      [decoded.uid]
    );

    const userRow = userResult.rows[0];

    if (!userRow) {
      return res.status(401).json({
        error: "Usuario no encontrado",
      });
    }

    if (!userRow.tenant_id) {
      return res.status(403).json({
        error: "El usuario no tiene un tenant asociado",
      });
    }

    const role = normalizeRole(userRow.role);
    const isAdmin = role === "admin";

    const selectedTenantId = isAdmin
      ? cleanTenantId(req.cookies?.admin_tenant_id)
      : null;

    let effectiveTenantId =
      selectedTenantId || userRow.tenant_id;

    /**
     * Nunca confiamos ciegamente en la cookie.
     * Si el tenant fue eliminado o no existe,
     * regresamos al tenant propio del administrador.
     */
    if (isAdmin && selectedTenantId) {
      const tenantResult = await pool.query(
        `
          SELECT id
          FROM tenants
          WHERE id = $1
          LIMIT 1
        `,
        [selectedTenantId]
      );

      if (!tenantResult.rows[0]) {
        effectiveTenantId = userRow.tenant_id;
        res.clearCookie("admin_tenant_id", {
          path: "/",
        });
      }
    }

    req.user = {
      uid: userRow.uid,
      email: userRow.email || decoded.email,
      role,
      is_admin: isAdmin,
      home_tenant_id: userRow.tenant_id,
      tenant_id: effectiveTenantId,
    };

    if (DEBUG_AUTH_LOGS) {
      console.log("👤 [AUTH]", {
        uid: req.user.uid,
        role: req.user.role,
        homeTenantId: req.user.home_tenant_id,
        effectiveTenantId: req.user.tenant_id,
      });
    }

    return next();
  } catch (error) {
    console.warn(
      `❌ [AUTH] Token inválido o expirado (${req.method} ${req.originalUrl})`
    );

    if (DEBUG_AUTH_LOGS) {
      console.error(error);
    }

    return res.status(403).json({
      error: "Token inválido",
    });
  }
};