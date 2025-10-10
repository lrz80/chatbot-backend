// ✅ src/routes/voice-prompt/index.ts
import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import { PromptTemplate } from "../../utils/voicePromptTemplate";

const router = express.Router();

const normLocale = (l?: string) => {
  const v = (l || "es-ES").toLowerCase();
  if (v.startsWith("en")) return "en-US";
  if (v.startsWith("pt")) return "pt-BR";
  return "es-ES";
};

router.post("/", authenticateUser, async (req, res) => {
  const tenant_id = (req.user as any)?.tenant_id as string | undefined;

  const {
    idioma,
    categoria,
    funciones_asistente,
    info_clave,
    // 👇 nueva bandera opcional desde el frontend
    modo_resumen_sms,
  } = req.body || {};

  if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado." });
  if (!idioma) return res.status(400).json({ error: "Falta idioma." });
  if (!funciones_asistente?.trim() || !info_clave?.trim()) {
    return res.status(400).json({ error: "Debes completar funciones e info clave." });
  }

  try {
    // Membresía
    const { rows } = await pool.query(
      `SELECT name, membresia_activa FROM tenants WHERE id = $1 LIMIT 1`,
      [tenant_id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Tenant no encontrado." });
    if (!rows[0].membresia_activa) {
      return res.status(403).json({ error: "Tu membresía está inactiva. Actívala para continuar." });
    }

    // Generar prompt + bienvenida (multi-tenant)
    const { prompt, bienvenida } = await PromptTemplate({
      idioma: normLocale(idioma),
      categoria: categoria || "default",
      tenant_id,
      funciones_asistente: funciones_asistente.trim(),
      info_clave: info_clave.trim(),
      // 👇 pasamos la bandera al template
      modo_resumen_sms: Boolean(modo_resumen_sms),
    });

    // Guardar/actualizar voice_config
    await pool.query(
      `INSERT INTO voice_configs (
         tenant_id, idioma, voice_name, system_prompt, welcome_message, voice_hints,
         canal, funciones_asistente, info_clave
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'voz', $7, $8)
       ON CONFLICT (tenant_id, idioma, canal) DO UPDATE SET
         voice_name = EXCLUDED.voice_name,
         system_prompt = EXCLUDED.system_prompt,
         welcome_message = EXCLUDED.welcome_message,
         voice_hints = EXCLUDED.voice_hints,
         funciones_asistente = EXCLUDED.funciones_asistente,
         info_clave = EXCLUDED.info_clave,
         updated_at = NOW()`,
      [
        tenant_id,
        normLocale(idioma),
        "alice",                 // voz por defecto
        prompt,
        bienvenida,
        null,                    // voice_hints opcional
        funciones_asistente.trim(),
        info_clave.trim(),
      ]
    );

    return res.json({ prompt, bienvenida });
  } catch (err) {
    console.error("❌ Error generando/guardando prompt de voz:", err);
    return res.status(500).json({ error: "Error generando el prompt." });
  }
});

export default router;
