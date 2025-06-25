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

router.post("/", authenticateUser, async (req: Request, res: Response) => {
    const { id } = req.body;
    const { user } = req as RequestConTenant; // ⬅️ type cast aquí
  
    if (!id || typeof id !== "number") {
      return res.status(400).json({ error: "ID inválido o faltante." });
    }
  
    try {
      const result = await pool.query(
        "DELETE FROM faqs WHERE id = $1 AND tenant_id = $2",
        [id, user.tenant_id]
      );
  
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "FAQ no encontrada o no pertenece a este tenant." });
      }
  
      return res.status(200).json({ message: "FAQ eliminada correctamente." });
    } catch (error) {
      console.error("❌ Error al eliminar FAQ:", error);
      return res.status(500).json({ error: "Error interno del servidor." });
    }
  });  

export default router;

