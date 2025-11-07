// backend/src/routes/channel-settings.ts
import { Router } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth"; // tu middleware de auth

const router = Router();

router.get("/", authenticateUser, async (req, res) => {
  try {
    const { canal } = req.query;
    const tenantId = req.user?.tenant_id;

    const result = await pool.query(
      "SELECT * FROM channel_settings WHERE tenant_id = $1 LIMIT 1",
      [tenantId]
    );

    const settings = result.rows[0] || {};
    if (!canal) return res.json(settings);

    // si pasas ?canal=sms, devuelve solo ese campo
    const key = `${canal}_enabled`;
    return res.json({ enabled: !!settings[key] });
  } catch (err) {
    console.error("❌ Error obteniendo channel_settings:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
