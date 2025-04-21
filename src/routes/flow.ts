import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

// Tipo para el flujo guiado (puedes mover esto a types/ si prefieres)
type FlowOption = {
  texto: string;
  respuesta?: string;
  submenu?: {
    mensaje: string;
    opciones: FlowOption[];
  };
};

type Flow = {
  mensaje: string;
  opciones: FlowOption[];
};

const router = express.Router();

// ✅ GET /api/flows
router.get("/api/flows", authenticateUser, async (req: Request, res: Response) => {
  try {
    const { tenant_id } = req.user;

    const result = await pool.query("SELECT data FROM flows WHERE tenant_id = $1", [tenant_id]);

    res.json(result.rows[0]?.data || []);
  } catch (err) {
    console.error("❌ Error al obtener flujos:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ✅ POST /api/flows
router.post("/api/flows", authenticateUser, async (req: Request, res: Response) => {
  try {
    const { tenant_id } = req.user;
    const flows: Flow[] = req.body.flows;

    if (!Array.isArray(flows)) {
      return res.status(400).json({ error: "Formato de flujos inválido" });
    }

    await pool.query(
      `INSERT INTO flows (tenant_id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [tenant_id, JSON.stringify(flows)]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error al guardar flujos:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
