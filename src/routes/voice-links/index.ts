// src/routes/voice-links/index.ts
import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

// 📥 Listar links útiles (opcional ?tipo=reservar|comprar|soporte|web)
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { tipo } = req.query as { tipo?: string };

  try {
    const params: any[] = [tenant_id];
    let sql = `
      SELECT id, tipo, nombre, url, created_at
      FROM links_utiles
      WHERE tenant_id = $1
    `;
    if (tipo) {
      sql += ` AND tipo = $2`;
      params.push(String(tipo).trim().toLowerCase());
    }
    sql += ` ORDER BY created_at DESC NULLS LAST, id DESC`;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error al obtener links útiles:", err);
    res.status(500).json({ error: "Error al obtener links útiles." });
  }
});

// 📤 Crear link útil
router.post("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  let { tipo, nombre, url } = req.body as { tipo?: string; nombre?: string; url?: string };

  if (!tipo || !nombre || !url) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }

  tipo = tipo.trim().toLowerCase();
  nombre = nombre.trim();
  url = url.trim();

  try {
    await pool.query(
      `INSERT INTO links_utiles (tenant_id, tipo, nombre, url, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [tenant_id, tipo, nombre, url]
    );

    const { rows } = await pool.query(
      `SELECT id, tipo, nombre, url, created_at
       FROM links_utiles
       WHERE tenant_id = $1
       ORDER BY created_at DESC NULLS LAST, id DESC`,
      [tenant_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("❌ Error al guardar link útil:", err);
    res.status(500).json({ error: "Error al guardar link útil." });
  }
});

// 🗑️ Eliminar link útil
router.delete("/:id", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido." });

  try {
    await pool.query(
      `DELETE FROM links_utiles
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenant_id]
    );
    res.status(204).end();
  } catch (err) {
    console.error("❌ Error al eliminar link útil:", err);
    res.status(500).json({ error: "Error al eliminar link." });
  }
});

export default router;
