import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

export const authenticateUser = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];

  if (!token) {
    console.warn("⚠️ Token no encontrado en cookies ni headers");
    return res.status(401).json({ error: "Token requerido" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    console.log("✅ TOKEN DECODIFICADO:", decoded); // 👈 Agregado

    req.user = {
      uid: decoded.uid,
      tenant_id: decoded.tenant_id,
      email: decoded.email,
    };

    console.log("👤 req.user asignado:", req.user); // 👈 Agregado

    next();
  } catch (err) {
    console.error("❌ Error al verificar token:", err);
    return res.status(403).json({ error: "Token inválido" });
  }
};

