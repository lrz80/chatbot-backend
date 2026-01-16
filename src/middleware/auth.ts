//src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import pool from "../lib/db";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const DEBUG_AUTH_LOGS = process.env.DEBUG_AUTH_LOGS === "true";

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

export const authenticateUser = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  // 1) Deja pasar preflights CORS (OPTIONS) sin tocar headers ni DB
  if (req.method === "OPTIONS") {
    return res.sendStatus(204); // o next(); si ya respondes OPTIONS globalmente
  }

  const rawAuth = req.headers?.authorization ?? "";

  if (DEBUG_AUTH_LOGS) {
    console.log("🔐 [AUTH]", req.method, req.originalUrl);
    console.log("🔐 [AUTH] Cookie token:", req.cookies?.token ? "✅ Sí" : "❌ No");
    console.log("🔐 [AUTH] Has Authorization:", rawAuth ? "✅ Sí" : "❌ No");
  }

  // 4) Soporta Bearer (case-insensitive)
  const lower = rawAuth.toLowerCase();
  const headerToken = lower.startsWith("bearer ") ? rawAuth.slice(7).trim() : undefined;

  // 5) Toma token de cookie o del header
  const token = req.cookies?.token || headerToken;

  if (!token) {
    console.warn(`⚠️ [AUTH] Token requerido (${req.method} ${req.originalUrl})`);
    return res.status(401).json({ error: "Token requerido" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (DEBUG_AUTH_LOGS) console.log("✅ [AUTH] Token verificado");

    // 6) Busca tenant_id
    const result = await pool.query(
      "SELECT tenant_id FROM users WHERE uid = $1 LIMIT 1",
      [decoded.uid]
    );
    const userRow = result.rows[0];
    if (!userRow) {
      console.warn(`⚠️ [AUTH] Usuario no encontrado (uid=${decoded?.uid ?? "?"})`);
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    req.user = {
      uid: decoded.uid,
      tenant_id: userRow.tenant_id,
      email: decoded.email,
    };

    if (DEBUG_AUTH_LOGS) console.log("👤 [AUTH] req.user asignado");
    return next();
  } catch (err) {
    console.warn(`❌ [AUTH] Token inválido/expirado (${req.method} ${req.originalUrl})`);
    if (DEBUG_AUTH_LOGS) console.error(err);
    return res.status(403).json({ error: "Token inválido" });
  }
};
