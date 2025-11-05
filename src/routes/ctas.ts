// src/routes/ctas.ts
import { Router, Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

// Shape real que pone tu middleware
type AuthedReq = Request & {
  user?: { uid: string; tenant_id: string; email?: string };
};

type CtaItem = {
  id?: number;
  intent: string;
  cta_text: string;
  cta_url: string;
  canal?: string;
  activo?: boolean;
  orden?: number;
};

const router = Router();
router.use(authenticateUser);

// -----------------------------
// Helpers
// -----------------------------
function isValidUrl(u?: string) {
  try {
    if (!u) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

function cleanItem(x: any, indexForOrder = 0): Required<CtaItem> {
  const intent = String(x?.intent || "").trim().toLowerCase();
  const cta_text = String(x?.cta_text || "").trim();
  const cta_url = String(x?.cta_url || "").trim();
  const canal = String(x?.canal || "whatsapp").trim().toLowerCase();
  const activo = x?.activo === false ? false : true;
  const orden =
    Number.isFinite(x?.orden) && x?.orden > 0 ? Number(x?.orden) : indexForOrder + 1;

  return { id: x?.id, intent, cta_text, cta_url, canal, activo, orden } as Required<CtaItem>;
}

// -----------------------------
// GET: listar CTAs del tenant por canal
// -----------------------------
router.get("/", async (req: AuthedReq, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "Unauthorized" });

    const canal = String(req.query.canal || "whatsapp").toLowerCase();

    const { rows } = await pool.query(
      `SELECT id, intent, cta_text, cta_url, canal, activo, orden, updated_at
       FROM tenant_ctas
       WHERE tenant_id = $1 AND canal = $2
       ORDER BY orden ASC, id ASC`,
      [tenantId, canal]
    );

    res.json(rows);
  } catch (err) {
    console.error("[CTAS][GET] Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// -----------------------------
// POST: guarda CTAs
// - Si recibe { ctas: CtaItem[] } => reemplaza el set del canal (transacción)
// - Si recibe un objeto { intent, cta_text, cta_url, canal? } => upsert por (tenant_id, canal, intent)
// -----------------------------
router.post("/", async (req: AuthedReq, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "Unauthorized" });

    // Caso A: array masivo
    if (Array.isArray((req.body as any)?.ctas)) {
      const canal = String(req.query.canal || "whatsapp").toLowerCase();
      const arr = (req.body as any).ctas as CtaItem[];

      const limpias = arr.map((x, i) => cleanItem({ ...x, canal }, i));

      if (limpias.some((it) => !it.intent || !it.cta_text || !it.cta_url)) {
        return res
          .status(400)
          .json({ error: "Todos los CTAs deben tener intent, cta_text y cta_url" });
      }
      if (limpias.some((it) => !isValidUrl(it.cta_url))) {
        return res.status(400).json({ error: "Hay URLs inválidas (deben iniciar con http(s)://)" });
      }

      await pool.query("BEGIN");
      // Reemplazo simple del set por canal
      await pool.query(
        `DELETE FROM tenant_ctas WHERE tenant_id = $1 AND canal = $2`,
        [tenantId, canal]
      );

      for (const it of limpias) {
        await pool.query(
          `INSERT INTO tenant_ctas
             (tenant_id, canal, intent, cta_text, cta_url, activo, orden, updated_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, now())`,
          [tenantId, it.canal, it.intent, it.cta_text, it.cta_url, it.activo, it.orden]
        );
      }

      await pool.query("COMMIT");
      return res.json({ ok: true, count: limpias.length });
    }

    // Caso B: objeto unitario (compatibilidad)
    const body = cleanItem(req.body || {});
    if (!body.intent || !body.cta_text || !body.cta_url) {
      return res
        .status(400)
        .json({ error: "Faltan campos: intent, cta_text, cta_url (y opcional canal, activo, orden)" });
    }
    if (!isValidUrl(body.cta_url)) {
      return res.status(400).json({ error: "cta_url inválida. Debe iniciar con http(s)://" });
    }

    const { rows } = await pool.query(
      `INSERT INTO tenant_ctas
         (tenant_id, canal, intent, cta_text, cta_url, activo, orden, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (tenant_id, canal, intent)
       DO UPDATE SET
         cta_text  = EXCLUDED.cta_text,
         cta_url   = EXCLUDED.cta_url,
         activo    = EXCLUDED.activo,
         orden     = EXCLUDED.orden,
         updated_at = now()
       RETURNING id, intent, cta_text, cta_url, canal, activo, orden, updated_at`,
      [tenantId, body.canal, body.intent, body.cta_text, body.cta_url, body.activo, body.orden]
    );

    res.json(rows[0]);
  } catch (err) {
    try {
      await pool.query("ROLLBACK");
    } catch {}
    console.error("[CTAS][POST] Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// -----------------------------
// DELETE: eliminar CTA por id (seguro por tenant)
// -----------------------------
router.delete("/:id", async (req: AuthedReq, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    await pool.query(`DELETE FROM tenant_ctas WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("[CTAS][DELETE] Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
