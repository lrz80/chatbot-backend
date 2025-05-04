import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

router.delete("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    // Elimina todas las tablas relacionadas con el tenant
    await pool.query("DELETE FROM mensajes_promocionales WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM campaign_usage WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM campanas WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM contactos WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM clientes WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM faqs WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM flows WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM follow_up_settings WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM intents WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM interactions WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM keywords WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM messages WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM prompts WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM sales_intelligence WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM voice_configs WHERE tenant_id = $1", [tenant_id]);

    // Eliminar usuario(s) y tenant
    await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenant_id]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenant_id]);

    res.status(200).json({ ok: true, message: "Cuenta eliminada correctamente." });
  } catch (err) {
    console.error("❌ Error al eliminar cuenta:", err);
    res.status(500).json({ error: "Error al eliminar la cuenta." });
  }
});

export default router;
