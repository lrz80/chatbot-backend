// src/routes/messages/nuevos.ts
import express from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

router.get("/", authenticateUser, async (req, res) => {
  const { canal = "", desde = "" } = req.query;
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      `SELECT * FROM messages
       WHERE tenant_id = $1
         AND ($2::text = '' OR canal = $2)
         AND timestamp > $3
       ORDER BY timestamp ASC`,
      [tenant_id, canal, desde]
    );

    res.json({ mensajes: result.rows });
  } catch (error) {
    console.error("❌ Error al obtener nuevos mensajes:", error);
    res.status(500).json({ error: "Error al obtener nuevos mensajes" });
  }
});

export default router;
