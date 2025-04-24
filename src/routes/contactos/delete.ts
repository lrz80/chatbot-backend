import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

router.delete("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    await pool.query("DELETE FROM contactos WHERE tenant_id = $1", [tenant_id]);
    res.status(200).json({ ok: true, message: "Contactos eliminados correctamente." });
  } catch (err) {
    console.error("❌ Error al eliminar contactos:", err);
    res.status(500).json({ error: "Error al eliminar contactos" });
  }
});

export default router;
