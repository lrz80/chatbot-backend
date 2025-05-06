// ✅ src/routes/voice-prompt/index.ts

import express from "express";
import { authenticateUser } from "../../middleware/auth";
import { PromptTemplate } from "../../utils/voicePromptTemplate";
import pool from "../../lib/db";

const router = express.Router();

router.post("/", authenticateUser, async (req, res) => {
  const { idioma, categoria, funciones_asistente, info_clave } = req.body;
  const tenant_id = req.user?.tenant_id;
  const canal = "voz";
  const voice_name = "alice";

  if (!idioma || !categoria) {
    return res.status(400).json({ error: "Faltan idioma o categoría." });
  }

  if (!tenant_id) {
    return res.status(401).json({ error: "Tenant no autenticado." });
  }

  if (!funciones_asistente?.trim() || !info_clave?.trim()) {
    return res.status(400).json({ error: "Debes completar funciones e info clave." });
  }

  try {
    // 🧠 Generar prompt usando funciones e info clave
    const { prompt, bienvenida } = await PromptTemplate({
      idioma,
      categoria,
      tenant_id,
      funciones_asistente,
      info_clave,
    });

    await pool.query(
      `INSERT INTO voice_configs (
        tenant_id, idioma, categoria, system_prompt, welcome_message, canal, voice_name, funciones_asistente, info_clave
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, canal) DO UPDATE SET
        idioma = EXCLUDED.idioma,
        categoria = EXCLUDED.categoria,
        system_prompt = EXCLUDED.system_prompt,
        welcome_message = EXCLUDED.welcome_message,
        voice_name = EXCLUDED.voice_name,
        funciones_asistente = EXCLUDED.funciones_asistente,
        info_clave = EXCLUDED.info_clave,
        updated_at = NOW()`,
      [
        tenant_id,
        idioma,
        categoria,
        prompt,
        bienvenida,
        canal,
        voice_name,
        funciones_asistente,
        info_clave,
      ]
    );

    res.json({ prompt, bienvenida });
  } catch (err) {
    console.error("❌ Error generando o guardando el prompt de voz:", err);
    res.status(500).json({ error: "Error generando el prompt." });
  }
});

export default router;
