// backend/src/routes/faqs/eliminar.ts

import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

// Middleware de autenticación
router.use(authenticateUser);

// POST /api/faqs/eliminar
router.post("/", async (req: Request, res: Response) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: "ID de FAQ requerido." });
  }

  try {
    const result = await pool.query("DELETE FROM faqs WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "FAQ no encontrada." });
    }

    return res.status(200).json({ success: true, id });
  } catch (error) {
    console.error("❌ Error al eliminar FAQ:", error);
    return res.status(500).json({ error: "Error al eliminar la FAQ." });
  }
});

export default router;
