// src/routes/voice-config/index.ts
import express from "express";
import multer from "multer";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import { normalizarNumero } from "../../lib/senders/sms";

const canonLocale = (x: string) =>
  x.startsWith("es") ? "es-ES" :
  x.startsWith("en") ? "en-US" :
  x.startsWith("pt") ? "pt-BR" :
  x;

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
    funciones_asistente:   norm(row.funciones_asistente),
    info_clave:            norm(row.info_clave),
    voice_hints:           norm(row.voice_hints),
    booking_services_text: norm(row.booking_services_text),
    main_menu_prompt:      norm(row.main_menu_prompt),
  };
};

// 📥 OBTENER configuración de voz
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const idiomaQ = String((req.query.idioma as string) || "es").toLowerCase();
  const canalQ = String((req.query.canal as string) || "voice").toLowerCase();

  const canon = (x: string) =>
    x.startsWith("es") ? "es-ES" :
    x.startsWith("en") ? "en-US" :
    x.startsWith("pt") ? "pt-BR" :
    x;

  const idiomaCanon = canon(idiomaQ);

  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM voice_configs
      WHERE tenant_id = $1
        AND lower(canal) = $2
        AND lower(idioma) = lower($3)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
      `,
      [tenant_id, canalQ, idiomaCanon]
    );

    return res.json(normRowForUI(rows[0] || {}));
  } catch (err) {
    console.error("❌ Error al obtener configuración de voz:", err);
    res.status(500).json({ error: "Error al obtener configuración." });
  }
});

// 📤 GUARDAR configuración de voz
router.post("/", authenticateUser, upload.none(), async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  const canonLocale = (x: string) =>
    x.startsWith("es") ? "es-ES" :
    x.startsWith("en") ? "en-US" :
    x.startsWith("pt") ? "pt-BR" :
    x;

  let {
    idioma,
    voice_name,
    system_prompt,
    welcome_message,
    main_menu_prompt,
    voice_hints,
    canal = "voice",
    funciones_asistente,
    info_clave,
    booking_services_text,
    audio_demo_url,
    representante_number
  } = req.body;

  idioma = canonLocale(toText(idioma).toLowerCase());
  voice_name = toText(voice_name) || "alice";
  system_prompt = toText(system_prompt);
  welcome_message = toText(welcome_message);
  main_menu_prompt = toText(main_menu_prompt);
  voice_hints = toText(voice_hints);
  canal = toText(canal) || "voice";
  funciones_asistente = toText(funciones_asistente);
  info_clave = toText(info_clave);
  booking_services_text = toText(booking_services_text);
  representante_number = toText(representante_number);

  if (!tenant_id) {
    return res.status(401).json({ error: "Tenant no autenticado." });
  }

  if (!idioma) {
    return res.status(400).json({ error: "Falta idioma." });
  }

  if (!system_prompt || !welcome_message) {
    return res.status(400).json({ error: "Prompt o mensaje de bienvenida vacío." });
  }

  if (representante_number) {
    try {
      representante_number = normalizarNumero(representante_number);
    } catch {
      return res.status(400).json({ error: "representante_number inválido" });
    }
  } else {
    representante_number = null as any;
  }

  try {
    await pool.query(
      `
      INSERT INTO voice_configs (
        tenant_id, idioma, voice_name, system_prompt, welcome_message, main_menu_prompt, voice_hints,
        canal, funciones_asistente, info_clave, booking_services_text, audio_demo_url, representante_number,
        created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NOW())
      ON CONFLICT (tenant_id, idioma, canal)
      DO UPDATE SET
        voice_name            = COALESCE(NULLIF(EXCLUDED.voice_name, ''), voice_configs.voice_name),
        system_prompt         = EXCLUDED.system_prompt,
        welcome_message       = EXCLUDED.welcome_message,
        main_menu_prompt      = EXCLUDED.main_menu_prompt,
        voice_hints           = EXCLUDED.voice_hints,
        funciones_asistente   = EXCLUDED.funciones_asistente,
        info_clave            = EXCLUDED.info_clave,
        booking_services_text = EXCLUDED.booking_services_text,
        audio_demo_url        = EXCLUDED.audio_demo_url,
        representante_number  = EXCLUDED.representante_number,
        updated_at            = NOW()
      `,
      [
        tenant_id,
        idioma,
        voice_name,
        system_prompt,
        welcome_message,
        main_menu_prompt || "",
        voice_hints || "",
        canal,
        funciones_asistente || "",
        info_clave || "",
        booking_services_text || "",
        audio_demo_url || null,
        representante_number || null,
      ]
    );

    res.status(200).json({ ok: true, message: "Configuración de voz guardada correctamente." });
  } catch (err) {
    console.error("❌ Error al guardar voice config:", err);
    res.status(500).json({ error: "Error interno al guardar configuración." });
  }
});

export default router;
