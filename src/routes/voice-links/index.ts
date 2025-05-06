import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

// 📥 Obtener links útiles
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      `SELECT * FROM links_utiles
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [tenant_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener links útiles:", err);
    res.status(500).json({ error: "Error al obtener links útiles." });
  }
});

// 📤 Agregar nuevo link útil
router.post("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { intencion, mensaje, url } = req.body;

  if (!intencion || !mensaje || !url) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }

  try {
    await pool.query(
      `INSERT INTO links_utiles (tenant_id, intencion, mensaje, url)
       VALUES ($1, $2, $3, $4)`,
      [tenant_id, intencion, mensaje, url]
    );

    const result = await pool.query(
      `SELECT * FROM links_utiles
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [tenant_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al guardar link útil:", err);
    res.status(500).json({ error: "Error al guardar link útil." });
  }
});

// 🗑️ Eliminar link útil
router.delete("/:id", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const linkId = parseInt(req.params.id);

  try {
    await pool.query(
      `DELETE FROM links_utiles
       WHERE id = $1 AND tenant_id = $2`,
      [linkId, tenant_id]
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error al eliminar link útil:", err);
    res.status(500).json({ error: "Error al eliminar link." });
  }
});

export default router;
