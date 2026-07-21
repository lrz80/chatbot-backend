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

  /**
   * Tenant efectivo utilizado por esta petición.
   *
   * Un usuario normal siempre utiliza su tenant asignado.
   * Un admin puede utilizar X-Tenant-ID para administrar otro tenant.
   */
  tenant_id: string;

  /**
   * Tenant originalmente asociado a la cuenta.
   */
  home_tenant_id: string;

  email?: string;
  role: UserRole;
  is_admin: boolean;
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

function readRequestedTenantId(req: Request): string | null {
  const rawHeader = req.headers["x-tenant-id"];

  if (Array.isArray(rawHeader)) {
    return rawHeader[0]?.trim() || null;
  }

  if (typeof rawHeader === "string") {
    return rawHeader.trim() || null;
  }

  return null;
}

export const authenticateUser = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  const rawAuth = req.headers.authorization ?? "";

  if (DEBUG_AUTH_LOGS) {
    console.log("🔐 [AUTH]", req.method, req.originalUrl);
    console.log(
      "🔐 [AUTH] Cookie token:",
      req.cookies?.token ? "✅ Sí" : "❌ No"
    );
    console.log(
      "🔐 [AUTH] Has Authorization:",
      rawAuth ? "✅ Sí" : "❌ No"
    );
  }

  const lowerAuthorization = rawAuth.toLowerCase();

  const headerToken = lowerAuthorization.startsWith("bearer ")
    ? rawAuth.slice(7).trim()
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
      console.warn(
        `⚠️ [AUTH] Usuario no encontrado (uid=${decoded.uid})`
      );

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
    const requestedTenantId = readRequestedTenantId(req);

    /**
     * Solo un admin puede sustituir el tenant mediante X-Tenant-ID.
     */
    const effectiveTenantId =
      isAdmin && requestedTenantId
        ? requestedTenantId
        : userRow.tenant_id;

    /**
     * Validar que el tenant seleccionado por el admin exista.
     */
    if (isAdmin && requestedTenantId) {
      const tenantResult = await pool.query(
        `
          SELECT id
          FROM tenants
          WHERE id = $1
          LIMIT 1
        `,
        [requestedTenantId]
      );

      if (!tenantResult.rows[0]) {
        return res.status(404).json({
          error: "El tenant seleccionado no existe",
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
      console.log("👤 [AUTH] Usuario autenticado", {
        uid: req.user.uid,
        role: req.user.role,
        isAdmin: req.user.is_admin,
        homeTenantId: req.user.home_tenant_id,
        effectiveTenantId: req.user.tenant_id,
      });
    }

    return next();
  } catch (error) {
    console.warn(
      `❌ [AUTH] Token inválido/expirado (${req.method} ${req.originalUrl})`
    );

    if (DEBUG_AUTH_LOGS) {
      console.error(error);
    }

    return res.status(403).json({
      error: "Token inválido",
    });
  }
};