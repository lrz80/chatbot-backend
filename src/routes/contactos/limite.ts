// src/routes/contactos/limite.ts

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

    if (!tenantId) return res.status(404).json({ error: "Tenant no encontrado" });

    // 🔄 Leer uso mensual de contactos
    const usoRes = await pool.query(`
      SELECT usados, limite
      FROM uso_mensual
      WHERE tenant_id = $1 AND canal = 'contactos' AND mes = date_trunc('month', CURRENT_DATE)
    `, [tenantId]);

    const usados = usoRes.rows[0]?.usados ?? 0;
    const limite = usoRes.rows[0]?.limite ?? 500;

    res.json({ limite, total: usados });
  } catch (err) {
    console.error("❌ Error en /contactos/limite:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
