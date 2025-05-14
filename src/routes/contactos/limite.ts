import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import pool from "../../lib/db";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const userRes = await pool.query("SELECT tenant_id FROM users WHERE uid = $1", [decoded.uid]);
    const tenantId = userRes.rows[0]?.tenant_id;

    const limiteRes = await pool.query("SELECT limite_contactos FROM tenants WHERE id = $1", [tenantId]);
    const limite = limiteRes.rows[0]?.limite_contactos ?? 500;

    const countRes = await pool.query("SELECT COUNT(*) FROM contactos WHERE tenant_id = $1", [tenantId]);
    const total = parseInt(countRes.rows[0]?.count || "0");

    res.json({ limite, total });
  } catch (err) {
    console.error("❌ Error en /contactos/limite:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
