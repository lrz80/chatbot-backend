// src/routes/flows.ts

import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

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
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    const result = await pool.query("SELECT data FROM flows WHERE tenant_id = $1", [tenant_id]);
    res.json(result.rows[0]?.data || []);
  } catch (err) {
    console.error("❌ Error al obtener flujos:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ✅ POST /api/flows
router.post("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    const flows: Flow[] = req.body.flows;
    if (!Array.isArray(flows)) return res.status(400).json({ error: "Formato de flujos inválido" });

    // 🛡️ Validar que cada flujo tenga mensaje y al menos una opción válida
    const flowsValidos = flows.filter((flow) =>
      flow.mensaje?.trim() &&
      Array.isArray(flow.opciones) &&
      flow.opciones.some((op) =>
        op.texto?.trim() && (op.respuesta?.trim() || op.submenu)
      )
    );

    if (flowsValidos.length === 0) {
      return res.status(400).json({ error: "No se recibieron flujos válidos" });
    }

    await pool.query(
      `INSERT INTO flows (tenant_id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [tenant_id, JSON.stringify(flowsValidos)]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error al guardar flujos:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
