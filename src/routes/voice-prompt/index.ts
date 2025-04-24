// src/routes/voice-prompt/index.ts

import express from "express";
import { authenticateUser } from "../../middleware/auth";
import { PromptTemplate } from "../../utils/voicePromptTemplate";
import pool from "../../lib/db";

const router = express.Router();

router.post("/", authenticateUser, async (req, res) => {
  const { idioma, categoria } = req.body;
  const tenant_id = req.user?.tenant_id;

  if (!idioma || !categoria) {
    return res.status(400).json({ error: "Faltan idioma o categoría." });
  }

  if (!tenant_id) {
    return res.status(401).json({ error: "Tenant no autenticado." });
  }

  try {
    const { prompt, bienvenida } = await PromptTemplate({ idioma, categoria, tenant_id });
    const voice_name = "alice";
    
    // Guardar en la tabla voice_configs
    await pool.query(
      `INSERT INTO voice_configs (tenant_id, idioma, categoria, system_prompt, welcome_message, canal, voice_name)
       VALUES ($1, $2, $3, $4, $5, 'voz', $6)
       ON CONFLICT (tenant_id) DO UPDATE 
       SET idioma = $2, categoria = $3, system_prompt = $4, welcome_message = $5, voice_name = $6, updated_at = NOW()`,
      [tenant_id, idioma, categoria, prompt, bienvenida, voice_name]
    );

    res.json({ prompt, bienvenida });
  } catch (err) {
    console.error("❌ Error generando o guardando el prompt de voz:", err);
    res.status(500).json({ error: "Error generando el prompt." });
  }
});

export default router;
