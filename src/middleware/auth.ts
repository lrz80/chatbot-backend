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

  console.log("🔐 [AUTH] Ruta solicitada:", req.method, req.originalUrl);
  console.log("🔐 [AUTH] Cookie recibida:", req.cookies?.token ? "✅ Sí" : "❌ No");
  const authHeader = req.headers.authorization || '';
  console.log("🔐 [AUTH] Header Authorization:", authHeader || "❌ No header");

  // Soporta "Bearer ..." (mayúsculas/minúsculas) y evita .split sin header
  const lower = authHeader.toLowerCase();
  const headerToken =
    lower.startsWith('bearer ') ? authHeader.slice(7).trim() : undefined;

  const token = req.cookies?.token || headerToken;

  if (!token) {
    console.warn("⚠️ Token no encontrado en cookies ni headers");
    return res.status(401).json({ error: "Token requerido" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    console.log("✅ TOKEN DECODIFICADO:", decoded);

    // ✅ Buscar el tenant_id real desde la base de datos
    const result = await pool.query("SELECT tenant_id FROM users WHERE uid = $1", [decoded.uid]);
    const user = result.rows[0];

    if (!user) {
      console.error("❌ Usuario no encontrado en la base de datos");
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    req.user = {
      uid: decoded.uid,
      tenant_id: user.tenant_id,
      email: decoded.email,
    };

    console.log("👤 req.user asignado:", req.user);
    next();
  } catch (err) {
    console.error("❌ Error al verificar token:", err);
    return res.status(403).json({ error: "Token inválido" });
  }
};
