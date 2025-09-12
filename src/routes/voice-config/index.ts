//src/routes/voice-config/index.ts

import express from "express";
import multer from "multer";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();
const upload = multer();

// 📥 OBTENER configuración de voz
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { idioma = "es-ES", canal = "voice" } = req.query; // <- voice

  try {
    const result = await pool.query(
      `SELECT * FROM voice_configs
       WHERE tenant_id = $1 AND idioma = $2 AND canal = $3
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [tenant_id, String(idioma), String(canal)]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error("❌ Error al obtener configuración de voz:", err);
    res.status(500).json({ error: "Error al obtener configuración." });
  }
});

router.post("/", authenticateUser, upload.none(), async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  let {
    idioma,
    voice_name,
    system_prompt,
    welcome_message,
    voice_hints,
    canal = "voice",                    // <- voice
    funciones_asistente,
    info_clave,
    audio_demo_url
  } = req.body;

  if (!idioma || !voice_name || !tenant_id) {
    return res.status(400).json({ error: "Faltan campos requeridos." });
  }
  if (!system_prompt?.trim() || !welcome_message?.trim()) {
    return res.status(400).json({ error: "Prompt o mensaje de bienvenida vacío." });
  }

  // Normaliza JSONs
  const toJson = (v: any, fallback: any) => {
    if (v == null || v === "") return fallback;
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return fallback; }
    }
    return v;
  };

  voice_hints = toJson(voice_hints, []);
  funciones_asistente = toJson(funciones_asistente, {});
  info_clave = toJson(info_clave, {});

  try {
    await pool.query(
      `INSERT INTO voice_configs (
        tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints,
        canal, funciones_asistente, info_clave, audio_demo_url, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), NOW())
      ON CONFLICT (tenant_id, idioma, canal)
      DO UPDATE SET
        voice_name = EXCLUDED.voice_name,
        system_prompt = EXCLUDED.system_prompt,
        welcome_message = EXCLUDED.welcome_message,
        voice_hints = EXCLUDED.voice_hints,
        funciones_asistente = EXCLUDED.funciones_asistente,
        info_clave = EXCLUDED.info_clave,
        audio_demo_url = EXCLUDED.audio_demo_url,
        updated_at = NOW()`,
      [
        tenant_id,
        idioma,
        voice_name,
        system_prompt,
        welcome_message,
        voice_hints,
        canal,
        funciones_asistente,
        info_clave,
        audio_demo_url || null
      ]
    );

    res.status(200).json({ ok: true, message: "Configuración de voz guardada correctamente." });
  } catch (err) {
    console.error("❌ Error al guardar voice config:", err);
    res.status(500).json({ error: "Error interno al guardar configuración." });
  }
});

export default router;
