import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import pool from "../lib/db";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

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

  // 2) Logs seguros
  console.log("🔐 [AUTH] Ruta solicitada:", req.method, req.originalUrl);
  console.log("🔐 [AUTH] Cookie recibida:", req.cookies?.token ? "✅ Sí" : "❌ No");

  // 3) NUNCA asumas que headers existe en compilados viejos → usa optional chaining
  const rawAuth = req.headers?.authorization ?? "";
  console.log("🔐 [AUTH] Header Authorization:", rawAuth || "❌ No header");

  // 4) Soporta Bearer (case-insensitive)
  const lower = rawAuth.toLowerCase();
  const headerToken = lower.startsWith("bearer ") ? rawAuth.slice(7).trim() : undefined;

  // 5) Toma token de cookie o del header
  const token = req.cookies?.token || headerToken;

  if (!token) {
    console.warn("⚠️ Token no encontrado en cookies ni headers");
    return res.status(401).json({ error: "Token requerido" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    console.log("✅ TOKEN DECODIFICADO:", decoded);

    // 6) Busca tenant_id
    const result = await pool.query(
      "SELECT tenant_id FROM users WHERE uid = $1 LIMIT 1",
      [decoded.uid]
    );
    const userRow = result.rows[0];
    if (!userRow) {
      console.error("❌ Usuario no encontrado en la base de datos");
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    req.user = {
      uid: decoded.uid,
      tenant_id: userRow.tenant_id,
      email: decoded.email,
    };

    console.log("👤 req.user asignado:", req.user);
    return next();
  } catch (err) {
    console.error("❌ Error al verificar token:", err);
    return res.status(403).json({ error: "Token inválido" });
  }
};
