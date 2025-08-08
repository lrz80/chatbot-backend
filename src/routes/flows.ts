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
  pregunta: string; // ← estándar
  opciones: FlowOption[];
};

const router = express.Router();

// ✅ GET /api/flows
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    // Si TS se queja de req.user, usa (req as any).user
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    const result = await pool.query("SELECT data FROM flows WHERE tenant_id = $1 LIMIT 1", [tenant_id]);
    const raw = result.rows[0]?.data;

    // Soporta jsonb (objeto/array) o texto JSON
    const parsed = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];

    // Normaliza clave 'pregunta' por si quedó guardado como 'mensaje'
    const data = Array.isArray(parsed)
      ? parsed.map((f: any) => ({
          pregunta: f?.pregunta ?? f?.mensaje ?? "",
          opciones: Array.isArray(f?.opciones) ? f.opciones : []
        }))
      : [];

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ data });
  } catch (err) {
    console.error("❌ Error al obtener flujos:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ✅ POST /api/flows
router.post("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    // Soporta: body = { flows: [...] } | { data: [...] } | [ ... ]
    const incoming = Array.isArray(req.body)
      ? req.body
      : (req.body?.flows ?? req.body?.data);

    if (!Array.isArray(incoming)) {
      return res.status(400).json({ error: "Formato de flujos inválido" });
    }

    // Normaliza cada flujo a { pregunta, opciones }
    const normalized: Flow[] = incoming.map((f: any) => ({
      pregunta: (f?.pregunta ?? f?.mensaje ?? "").toString().trim(),
      opciones: Array.isArray(f?.opciones) ? f.opciones : []
    }));

    // Valida contenido (pregunta y al menos una opción válida)
    const flowsValidos = normalized.filter((flow) =>
      flow.pregunta &&
      flow.opciones.some((op: FlowOption) =>
        (op?.texto?.toString().trim()) &&
        ((op?.respuesta?.toString().trim()) || op?.submenu)
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

    return res.status(200).json({ success: true, data: flowsValidos });
  } catch (err) {
    console.error("❌ Error al guardar flujos:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

export default router;
