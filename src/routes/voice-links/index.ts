// src/routes/voice-links/index.ts
import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

// 📥 Obtener links útiles (por tenant)
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const { rows } = await pool.query(
      `SELECT id, tipo, nombre, url, tenant_id, created_at
         FROM links_utiles
        WHERE tenant_id = $1
        ORDER BY created_at DESC NULLS LAST, id DESC`,
      [tenant_id]
    );
    console.log(`[voice-links] GET tenant=${tenant_id} -> ${rows.length} link(s)`);
    return res.json(rows);
  } catch (err) {
    console.error("❌ Error al obtener links útiles:", err);
    return res.status(500).json({ error: "Error al obtener links útiles." });
  }
});

// 📤 Agregar nuevo link útil
router.post("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { tipo, nombre, url } = req.body;

  if (!tipo || !nombre || !url) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }

  try {
    await pool.query(
      `INSERT INTO links_utiles (tenant_id, tipo, nombre, url, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [tenant_id, tipo.trim(), nombre.trim(), url.trim()]
    );

    const { rows } = await pool.query(
      `SELECT id, tipo, nombre, url, tenant_id, created_at
         FROM links_utiles
        WHERE tenant_id = $1
        ORDER BY created_at DESC NULLS LAST, id DESC`,
      [tenant_id]
    );

    console.log(`[voice-links] POST tenant=${tenant_id} -> total=${rows.length}`);
    return res.json(rows);
  } catch (err) {
    console.error("❌ Error al guardar link útil:", err);
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
      `DELETE FROM links_utiles
        WHERE id = $1 AND tenant_id = $2`,
      [linkId, tenant_id]
    );
    console.log(`[voice-links] DELETE tenant=${tenant_id} id=${linkId} rowCount=${r.rowCount}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error al eliminar link útil:", err);
    return res.status(500).json({ error: "Error al eliminar link." });
  }
});

export default router;
