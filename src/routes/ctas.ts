// src/routes/ctas.ts
import { Router, Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";
import { normalizeIntentAlias, intentToSlug } from "../lib/intentSlug";

// Shape real que pone tu middleware
type AuthedReq = Request & {
  user?: { uid: string; tenant_id: string; email?: string };
};

type CtaItem = {
  id?: number;
  intent: string;
  intent_slug?: string;
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
  const intentRaw = String(x?.intent || "").trim().toLowerCase();

  // canónico + slug
  const intent = normalizeIntentAlias(intentRaw);
  const intent_slug = intentToSlug(intentRaw); // (usa alias internamente)

  const cta_text = String(x?.cta_text || "").trim();
  const cta_url  = String(x?.cta_url  || "").trim();
  const canal    = String(x?.canal    || "whatsapp").trim().toLowerCase();
  const activo   = x?.activo === false ? false : true;
  const orden    = Number.isFinite(x?.orden) && x?.orden > 0 ? Number(x?.orden) : indexForOrder + 1;

  return { id: x?.id, intent, intent_slug, cta_text, cta_url, canal, activo, orden } as Required<CtaItem>;
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
      `SELECT id, intent, intent_slug, cta_text, cta_url, canal, activo, orden, updated_at
         FROM tenant_ctas
        WHERE tenant_id = $1 AND canal = $2 AND deleted = FALSE
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

      await pool.query(
        `DELETE FROM tenant_ctas WHERE tenant_id = $1 AND canal = $2`,
        [tenantId, canal]
        );

        for (const it of limpias) {
        await pool.query(
            `INSERT INTO tenant_ctas
            (tenant_id, canal, intent, intent_slug, cta_text, cta_url, activo, orden, deleted, updated_at)
            VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, now())
            ON CONFLICT (tenant_id, canal, intent_slug)
            DO UPDATE SET
            intent     = EXCLUDED.intent,
            cta_text   = EXCLUDED.cta_text,
            cta_url    = EXCLUDED.cta_url,
            activo     = EXCLUDED.activo,
            orden      = EXCLUDED.orden,
            deleted    = FALSE,
            updated_at = now()`,
            [tenantId, it.canal, it.intent, it.intent_slug, it.cta_text, it.cta_url, it.activo, it.orden]
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
          (tenant_id, canal, intent, intent_slug, cta_text, cta_url, activo, orden, deleted, updated_at)
      VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, now())
      ON CONFLICT (tenant_id, canal, intent_slug)
      DO UPDATE SET
          intent     = EXCLUDED.intent,
          cta_text   = EXCLUDED.cta_text,
          cta_url    = EXCLUDED.cta_url,
          activo     = EXCLUDED.activo,
          orden      = EXCLUDED.orden,
          deleted    = FALSE,
          updated_at = now()
      RETURNING id, intent, intent_slug, cta_text, cta_url, canal, activo, orden, updated_at`,
     [tenantId, body.canal, body.intent, body.intent_slug, body.cta_text, body.cta_url, body.activo, body.orden]
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

// DELETE: borrado duro por intent (sin tombstone) + limpia filas viejas sin slug
router.delete("/:intent", async (req: AuthedReq, res: Response) => {
  const client = await pool.connect();
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(401).json({ ok: false, error: "unauthorized" });

    const canal = String(req.query.canal || "whatsapp").toLowerCase();
    const raw   = String(req.params.intent || "").trim();
    const canonical = normalizeIntentAlias(raw.toLowerCase());
    const slug  = intentToSlug(raw);

    if (!slug) return res.status(400).json({ ok: false, error: "invalid-intent" });

    await client.query("BEGIN");

    // Borra cualquier fila del tenant para ese intent/canal:
    //  - coincidencia por slug correcto
    //  - coincidencia por intent canónico con slug nulo/vacío (legacy)
    await client.query(
      `
      DELETE FROM tenant_ctas
      WHERE tenant_id = $1
        AND canal = $2
        AND (
              intent_slug = $3
           OR (intent = $4 AND (intent_slug IS NULL OR intent_slug = ''))
        )
      `,
      [tenantId, canal, slug, canonical]
    );

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[CTAs:DELETE] error:", e);
    return res.status(500).json({ ok: false, error: "db-error" });
  } finally {
    client.release();
  }
});

export default router;
