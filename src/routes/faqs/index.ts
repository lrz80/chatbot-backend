// src/routes/faqs/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

type FaqIn = {
  id?: number;
  pregunta: string;
  respuesta: string;
  intencion?: string | null;
  canal?: string | null;
};

const CANAL_GROUPS: Record<string, string[]> = {
  meta: ["meta", "facebook", "instagram"],
  whatsapp: ["whatsapp"],
  facebook: ["facebook"],
  instagram: ["instagram"],
  voz: ["voz"],
};

function normalizeCanales(raw: any): string[] {
  const c = (raw as string)?.toLowerCase();
  if (!c) return ["whatsapp"];
  return CANAL_GROUPS[c] ?? [c];
}

function capitalizar(texto: string): string {
  if (!texto) return "";
  const s = texto.toString().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ✅ GET /api/faqs
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    const canales = normalizeCanales(req.query.canal);

    const { rows } = await pool.query(
      `SELECT id, pregunta, respuesta, intencion, canal
         FROM faqs
        WHERE tenant_id = $1
          AND canal = ANY($2::text[])
        ORDER BY id DESC`,
      [tenant_id, canales]
    );

    res.set("Cache-Control", "no-store");
    return res.status(200).json(rows);
  } catch (err) {
    console.error("❌ Error GET /faqs:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ✅ POST /api/faqs
router.post("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: "Tenant no autenticado" });

    // Canal puede venir por query o body; default whatsapp
    const canalParam =
      (req.query.canal as string)?.toLowerCase() ||
      (req.body?.canal as string)?.toLowerCase() ||
      "whatsapp";

    // Grupo de canales para limpiar antes de insertar
    const canalesGrupo = normalizeCanales(canalParam);

    // Lo que guardamos finalmente (facebook/instagram → meta)
    const canalDestino =
      canalParam === "facebook" || canalParam === "instagram" ? "meta" : canalParam;

    const incoming: FaqIn[] = Array.isArray(req.body?.faqs) ? req.body.faqs : [];

    const preparados = incoming
      .map((f) => ({
        pregunta: capitalizar(f.pregunta || ""),
        respuesta: (f.respuesta || "").toString().trim(),
        intencion: f.intencion ? String(f.intencion).trim().toLowerCase() : null, // ← opcional
        canal: canalDestino,
      }))
      .filter((f) => f.pregunta && f.respuesta);

    if (preparados.length === 0) {
      return res.status(400).json({ error: "No se recibieron FAQs válidas" });
    }

    // Reemplazar solo las FAQs del grupo del canal (no las de otros canales)
    await pool.query(
      `DELETE FROM faqs
        WHERE tenant_id = $1
          AND canal = ANY($2::text[])`,
      [tenant_id, canalesGrupo]
    );

    const values: any[] = [];
    const tuples = preparados
      .map((f, i) => {
        const base = i * 5;
        values.push(tenant_id, f.pregunta, f.respuesta, f.intencion, f.canal);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      })
      .join(",");

    await pool.query(
      `INSERT INTO faqs (tenant_id, pregunta, respuesta, intencion, canal)
       VALUES ${tuples}`,
      values
    );

    return res.status(200).json({ success: true, count: preparados.length });
  } catch (err) {
    console.error("❌ Error POST /faqs:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

export default router;
