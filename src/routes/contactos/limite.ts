// src/routes/contactos/limite.ts
import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import pool from "../../lib/db";

const router = Router();

/**
 * Límite = 500 base + SUM(creditos_comprados.cantidad vigentes)
 * total   = COUNT(contactos) del tenant
 * restante = max(límite - total, 0)
 */
router.get("/", async (req: Request, res: Response) => {
  const token = (req as any).cookies?.token;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);

    // 1) tenant_id
    const userRes = await pool.query(
      "SELECT tenant_id FROM users WHERE uid = $1",
      [decoded.uid]
    );
    const tenantId = userRes.rows[0]?.tenant_id;
    if (!tenantId) return res.status(404).json({ error: "Tenant no encontrado" });

    // 2) contactos actuales
    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS total FROM contactos WHERE tenant_id = $1",
      [tenantId]
    );
    const total = countRes.rows[0]?.total ?? 0;

    // 3) extras vigentes (duran 1 mes desde la compra => respetamos fecha_vencimiento)
    const extrasRes = await pool.query(
      `
      SELECT COALESCE(SUM(cantidad), 0)::int AS extra_vigente
      FROM creditos_comprados
      WHERE tenant_id = $1
        AND canal = 'contactos'
        AND NOW() <= fecha_vencimiento   -- ✅ incluye el instante exacto de vencimiento
      `,
      [tenantId]
    );
    const extraVigente = extrasRes.rows[0]?.extra_vigente ?? 0;

    // 4) límite total
    const limite = 500 + extraVigente;
    const restante = Math.max(limite - total, 0);

    return res.json({
      limite,
      total,
      restante,
      extras_vigentes: extraVigente
    });
  } catch (err) {
    console.error("❌ Error en /contactos/limite:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

export default router;
