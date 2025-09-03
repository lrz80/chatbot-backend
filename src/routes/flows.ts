// src/routes/flows.ts
import express, { Request, Response, RequestHandler } from "express";
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
  pregunta: string;
  opciones: FlowOption[];
};

const router = express.Router();

/* ------------------------- GET /api/flows ------------------------- */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    const canal = (req.query.canal as string) || "whatsapp";

    const result = await pool.query(
      "SELECT data FROM flows WHERE tenant_id = $1 AND canal = $2 LIMIT 1",
      [tenant_id, canal]
    );

    const raw = result.rows[0]?.data;
    const parsed = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];

    const data = Array.isArray(parsed)
      ? parsed.map((f: any) => ({
          pregunta: f?.pregunta ?? f?.mensaje ?? "",
          opciones: Array.isArray(f?.opciones) ? f.opciones : [],
        }))
      : [];

    res.set("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (err) {
    console.error("❌ Error al obtener flujos:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

/* --------------- Handler reutilizable (PUT y POST) ---------------- */
const saveFlowsHandler: RequestHandler = async (req, res) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    const canal = (req.query.canal as string) || "whatsapp";

    console.log("➡️ Guardar flows", {
      tenant_id,
      canal,
      bodyType: typeof req.body,
      isArray: Array.isArray(req.body),
      keys: Object.keys(req.body || {}),
    });

    const incoming = Array.isArray(req.body) ? req.body : (req.body as any)?.flows ?? (req.body as any)?.data;

    if (!Array.isArray(incoming)) {
      return res.status(400).json({ error: "Formato de flujos inválido" });
    }

    const normalized: Flow[] = incoming.map((f: any) => ({
      pregunta: (f?.pregunta ?? f?.mensaje ?? "").toString().trim(),
      opciones: Array.isArray(f?.opciones) ? f.opciones : [],
    }));

    const flowsValidos = normalized.filter(
      (flow) =>
        flow.pregunta &&
        flow.opciones.some(
          (op: FlowOption) =>
            op?.texto?.toString().trim() &&
            ((op?.respuesta?.toString().trim()) || op?.submenu)
        )
    );

    if (flowsValidos.length === 0) {
      return res.status(400).json({ error: "No se recibieron flujos válidos" });
    }

    await pool.query(
      `INSERT INTO flows (tenant_id, canal, data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, canal)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [tenant_id, canal, JSON.stringify(flowsValidos)]
    );

    return res.status(200).json({ success: true, data: flowsValidos });
  } catch (err) {
    console.error("❌ Error al guardar flujos:", err);
    return res.status(500).json({ error: "Error interno" });
  }
};

/* --------------------- PUT y POST (alias) ------------------------- */
router.put("/", authenticateUser, saveFlowsHandler);
router.post("/", authenticateUser, saveFlowsHandler);

export default router;
