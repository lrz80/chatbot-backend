// src/routes/voice-prompt/index.ts

import express from "express";
import { authenticateUser } from "../../middleware/auth";
import { PromptTemplate } from "../../utils/voicePromptTemplate";
import pool from "../../lib/db";

const router = express.Router();

router.post("/", authenticateUser, async (req, res) => {
  const { idioma, categoria, funciones_asistente, info_clave } = req.body;
  const tenant_id = req.user?.tenant_id;

  if (!idioma || !categoria) {
    return res.status(400).json({ error: "Faltan idioma o categoría." });
  }

  if (!tenant_id) {
    return res.status(401).json({ error: "Tenant no autenticado." });
  }

  try {
    // 🧠 Generar prompt usando funciones e info clave si vienen del cliente
    const { prompt, bienvenida } = await PromptTemplate({
      idioma,
      categoria,
      tenant_id,
      funciones_asistente: funciones_asistente || "",
      info_clave: info_clave || "",
    });

    const voice_name = "alice";

    await pool.query(
      `INSERT INTO voice_configs (
        tenant_id, idioma, categoria, system_prompt, welcome_message, canal, voice_name, funciones_asistente, info_clave
      ) VALUES ($1, $2, $3, $4, $5, 'voz', $6, $7, $8)
      ON CONFLICT (tenant_id) DO UPDATE SET
        idioma = $2,
        categoria = $3,
        system_prompt = $4,
        welcome_message = $5,
        voice_name = $6,
        funciones_asistente = $7,
        info_clave = $8,
        updated_at = NOW()`,
      [tenant_id, idioma, categoria, prompt, bienvenida, voice_name, funciones_asistente || '', info_clave || '']
    );

    res.json({ prompt, bienvenida });
  } catch (err) {
    console.error("❌ Error generando o guardando el prompt de voz:", err);
    res.status(500).json({ error: "Error generando el prompt." });
  }
});

export default router;
