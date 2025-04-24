import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      "SELECT COUNT(*) FROM contactos WHERE tenant_id = $1",
      [tenant_id]
    );
    const total = Number(result.rows[0].count);
    res.json({ total });
  } catch (err) {
    console.error("❌ Error al contar contactos:", err);
    res.status(500).json({ error: "Error al contar contactos" });
  }
});

export default router;
