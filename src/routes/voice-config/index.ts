// src/routes/voice-config/index.ts
import express from "express";
import multer from "multer";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import { normalizarNumero } from "../../lib/senders/sms";

const router = express.Router();
const upload = multer();

/** Convierte cualquier valor a string “limpio” para DB/UI */
const toText = (v: any) => {
  if (v == null) return "";
  if (typeof v === "object") return "";     // evita {}
  const s = String(v).trim();
  return s === "{}" ? "" : s;               // evita "{}" como texto
};

/** Normaliza campos que puedan venir como {} / [] desde la DB */
const normRowForUI = (row: any = {}) => {
  const norm = (v: any) => {
    if (v == null) return "";
    if (typeof v === "object") return "";   // json/jsonb -> ""
    const s = String(v).trim();
    return s === "{}" ? "" : s;
  };
  return {
    ...row,
    funciones_asistente: norm(row.funciones_asistente),
    info_clave:           norm(row.info_clave),
    voice_hints:          norm(row.voice_hints),
  };
};

// 📥 OBTENER configuración de voz
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { idioma = "es-ES", canal = "voz" } = req.query; // ✅ usa "voz"

  try {
    const { rows } = await pool.query(
      `SELECT *
         FROM voice_configs
        WHERE tenant_id = $1
          AND idioma    = $2
          AND canal     = $3
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      [tenant_id, String(idioma), String(canal)]
    );

    return res.json(normRowForUI(rows[0]));
  } catch (err) {
    console.error("❌ Error al obtener configuración de voz:", err);
    res.status(500).json({ error: "Error al obtener configuración." });
  }
});

// 📤 GUARDAR configuración de voz
router.post("/", authenticateUser, upload.none(), async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  let {
    idioma,
    voice_name,
    system_prompt,
    welcome_message,
    voice_hints,
    canal = "voz",                 // ✅ usa "voz"
    funciones_asistente,
    info_clave,
    audio_demo_url,
    representante_number
  } = req.body;

  // Normaliza a texto
  idioma              = toText(idioma);
  voice_name          = toText(voice_name) || "alice";
  system_prompt       = toText(system_prompt);
  welcome_message     = toText(welcome_message);
  voice_hints         = toText(voice_hints);
  canal               = toText(canal) || "voz";
  funciones_asistente = toText(funciones_asistente);
  info_clave          = toText(info_clave);
  representante_number = toText(representante_number);

  if (!tenant_id) {
    return res.status(401).json({ error: "Tenant no autenticado." });
  }
  if (!idioma) {
  return res.status(400).json({ error: "Falta idioma." });
  }
  // voice_name es opcional: si viene vacío, usamos 'alice' como default
  voice_name = voice_name || "alice";
  if (!system_prompt || !welcome_message) {
    return res.status(400).json({ error: "Prompt o mensaje de bienvenida vacío." });
  }
  if (representante_number) {
    try {
      representante_number = normalizarNumero(representante_number); // ej: +13057206515
    } catch {
      return res.status(400).json({ error: "representante_number inválido" });
    }
  } else {
    representante_number = null as any;
  }

  try {
    await pool.query(
      `INSERT INTO voice_configs (
         tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints,
         canal, funciones_asistente, info_clave, audio_demo_url, representante_number, created_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW())
       ON CONFLICT ON CONSTRAINT unique_voice_config_per_tenant
       DO UPDATE SET
         voice_name          = EXCLUDED.voice_name,
         system_prompt       = EXCLUDED.system_prompt,
         welcome_message     = EXCLUDED.welcome_message,
         voice_hints         = EXCLUDED.voice_hints,
         funciones_asistente = EXCLUDED.funciones_asistente,
         info_clave          = EXCLUDED.info_clave,
         audio_demo_url      = EXCLUDED.audio_demo_url,
         representante_number = EXCLUDED.representante_number,
         updated_at          = NOW()`,
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
        audio_demo_url || null,
        representante_number
      ]
    );

    res.status(200).json({ ok: true, message: "Configuración de voz guardada correctamente." });
  } catch (err) {
    console.error("❌ Error al guardar voice config:", err);
    res.status(500).json({ error: "Error interno al guardar configuración." });
  }
});

export default router;
