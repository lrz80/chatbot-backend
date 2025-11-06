// src/middleware/requireChannel.ts
import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";

const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

const planMatrix: Record<string, { meta: boolean }> = {
  trial:    { meta: false },
  starter:  { meta: false },
  pro:      { meta: true  },
  business: { meta: true  },
};

export function requireChannel(channel: "meta") {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.token;
      if (!token) return res.status(401).json({ error: "No autorizado" });
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

      const { rows } = await pool.query(
        `SELECT t.plan, t.membresia_activa
           FROM users u
           JOIN tenants t ON t.id = u.tenant_id
          WHERE u.uid = $1
          LIMIT 1`,
        [decoded.uid]
      );
      const row = rows[0];
      if (!row) return res.status(403).json({ error: "Sin tenant" });

      const plan = row.plan || "starter";
      const active = !!row.membresia_activa;

      const allowed = active && !!planMatrix[plan]?.[channel];
      if (!allowed) return res.status(403).json({ error: "Canal bloqueado por tu plan" });

      return next();
    } catch (e) {
      return res.status(401).json({ error: "No autorizado" });
    }
  };
}
