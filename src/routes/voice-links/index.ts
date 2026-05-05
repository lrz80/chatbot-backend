// src/routes/voice-links/index.ts
import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

const DEFAULT_CHANNEL = "voice";
const DEFAULT_LANGUAGE = "es-ES";

function normalizeOptionalString(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveChannel(value: unknown): string {
  const channel = normalizeOptionalString(value);
  return channel || DEFAULT_CHANNEL;
}

function resolveLanguage(value: unknown): string {
  const language = normalizeOptionalString(value);
  return language || DEFAULT_LANGUAGE;
}

// 📥 Obtener links útiles por tenant + canal + idioma
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const canal = resolveChannel(req.query.canal);
  const idioma = resolveLanguage(req.query.idioma);

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        tipo,
        nombre,
        url,
        tenant_id,
        canal,
        idioma,
        created_at
      FROM links_utiles
      WHERE tenant_id = $1
        AND canal = $2
        AND idioma = $3
      ORDER BY created_at DESC NULLS LAST, id DESC
      `,
      [tenant_id, canal, idioma]
    );

    console.log(
      `[voice-links] GET tenant=${tenant_id} canal=${canal} idioma=${idioma} -> ${rows.length} link(s)`
    );

    return res.json(rows);
  } catch (err) {
    console.error("❌ Error al obtener links útiles:", {
      tenant_id,
      canal,
      idioma,
      err,
    });
    return res.status(500).json({ error: "Error al obtener links útiles." });
  }
});

// 📤 Agregar nuevo link útil por tenant + canal + idioma
router.post("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  const tipo = normalizeOptionalString(req.body?.tipo);
  const nombre = normalizeOptionalString(req.body?.nombre);
  const url = normalizeOptionalString(req.body?.url);
  const canal = resolveChannel(req.body?.canal);
  const idioma = resolveLanguage(req.body?.idioma);

  if (!tipo || !nombre || !url) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }

  try {
    await pool.query(
      `
      INSERT INTO links_utiles (
        tenant_id,
        canal,
        idioma,
        tipo,
        nombre,
        url,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `,
      [tenant_id, canal, idioma, tipo, nombre, url]
    );

    const { rows } = await pool.query(
      `
      SELECT
        id,
        tipo,
        nombre,
        url,
        tenant_id,
        canal,
        idioma,
        created_at
      FROM links_utiles
      WHERE tenant_id = $1
        AND canal = $2
        AND idioma = $3
      ORDER BY created_at DESC NULLS LAST, id DESC
      `,
      [tenant_id, canal, idioma]
    );

    console.log(
      `[voice-links] POST tenant=${tenant_id} canal=${canal} idioma=${idioma} -> total=${rows.length}`
    );

    return res.json(rows);
  } catch (err) {
    console.error("❌ Error al guardar link útil:", {
      tenant_id,
      canal,
      idioma,
      err,
    });
    return res.status(500).json({ error: "Error al guardar link útil." });
  }
});

// 🗑️ Eliminar link útil
router.delete("/:id", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const linkId = Number(req.params.id);

  if (!Number.isFinite(linkId)) {
    return res.status(400).json({ error: "ID inválido." });
  }

  try {
    const r = await pool.query(
      `
      DELETE FROM links_utiles
      WHERE id = $1
        AND tenant_id = $2
      `,
      [linkId, tenant_id]
    );

    console.log(
      `[voice-links] DELETE tenant=${tenant_id} id=${linkId} rowCount=${r.rowCount}`
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error al eliminar link útil:", {
      tenant_id,
      linkId,
      err,
    });
    return res.status(500).json({ error: "Error al eliminar link." });
  }
});

export default router;