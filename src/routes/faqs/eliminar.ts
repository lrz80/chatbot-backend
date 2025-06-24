// backend/src/routes/faqs/eliminar.ts

import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

interface RequestConTenant extends Request {
  user: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

const router = Router();

router.post("/api/faqs/eliminar", authenticateUser, async (req, res) => {
  const { id } = req.body;
  const { tenant_id } = (req as RequestConTenant).user;

  if (!id || isNaN(id)) {
    console.log("❌ ID inválido recibido:", id);
    return res.status(400).json({ error: "ID inválido" });
  }  

  try {
    const result = await pool.query(
      "DELETE FROM faqs WHERE id = $1 AND tenant_id = $2",
      [id, tenant_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "FAQ no encontrada o no pertenece al tenant" });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error eliminando FAQ:", err);
    return res.status(500).json({ error: "Error al eliminar FAQ" });
  }
});

export default router;
