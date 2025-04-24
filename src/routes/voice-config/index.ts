import express from "express";
import multer from "multer";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();
const upload = multer();

// 🔄 GUARDAR configuración de voz
router.post("/", authenticateUser, upload.none(), async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { idioma, voice_name, system_prompt, welcome_message, voice_hints, canal = "voz" } = req.body;

  if (!idioma || !voice_name || !tenant_id) {
    return res.status(400).json({ error: "Faltan campos requeridos." });
  }

  try {
    // Eliminar configuraciones anteriores por idioma y canal
    await pool.query(
      "DELETE FROM voice_configs WHERE tenant_id = $1 AND idioma = $2 AND canal = $3",
      [tenant_id, idioma, canal]
    );

    await pool.query(
      `INSERT INTO voice_configs (
        tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints, canal
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints, canal]
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error al guardar voice config:", err);
    res.status(500).json({ error: "Error interno al guardar configuración." });
  }
});

// 📥 OBTENER configuración de voz
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { idioma = "es-ES", canal = "voz" } = req.query;

  try {
    const result = await pool.query(
      `SELECT * FROM voice_configs
       WHERE tenant_id = $1 AND idioma = $2 AND canal = $3
       ORDER BY created_at DESC LIMIT 1`,
      [tenant_id, idioma, canal]
    );

    res.json(result.rows[0] || {});
  } catch (err) {
    console.error("❌ Error al obtener configuración de voz:", err);
    res.status(500).json({ error: "Error al obtener configuración." });
  }
});

export default router;
