// src/routes/faqs/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import stringSimilarity from "string-similarity";

const router = Router();

type FaqIn = {
  id?: number;
  pregunta: string;
  respuesta: string;
  intencion?: string | null;
  canal?: string | null;
};

const CANAL_GROUPS: Record<string, string[]> = {
    // Ecosistema Meta UNIFICADO
    meta: ["meta", "facebook", "instagram"],
    facebook: ["meta", "facebook", "instagram"],
    instagram: ["meta", "facebook", "instagram"],
    // Canales independientes
    whatsapp: ["whatsapp"],
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

// === Helpers para deduplicar por intención / similitud ===
const normalize = (s: string) =>
    s
      ?.toString()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || "";
  
  // Aliases simples para inferir intención cuando venga vacía
  const INTENT_ALIASES: Record<string, string[]> = {
    interes_clases: [
      "reservar clase",
      "probar clase",
      "clase de prueba",
      "primera clase",
      "free class",
      "trial class",
      "test class",
    ],
  };
  
  function inferirIntencion(pregunta: string): string | null {
    const q = normalize(pregunta);
    for (const [intent, terms] of Object.entries(INTENT_ALIASES)) {
      if (terms.some((t) => q.includes(normalize(t)))) return intent;
    }
    return null;
  }
  
  const UMBRAL_SIMILITUD = 0.82; // baja a 0.80 si hace falta
  const esSimilar = (a: string, b: string) =>
    stringSimilarity.compareTwoStrings(normalize(a), normalize(b)) >= UMBRAL_SIMILITUD;
  
  // Dedupe por intención priorizando: con intención > sin intención; más larga = más completa
  function dedupeFaqs(faqs: FaqIn[]): FaqIn[] {
    const byIntent = new Map<string, FaqIn>(); // clave por intención
    const sinIntent: FaqIn[] = [];
  
    for (const f of faqs) {
      const intent = f.intencion || inferirIntencion(f.pregunta) || null;
      if (intent) {
        const prev = byIntent.get(intent);
        if (!prev) {
          byIntent.set(intent, f);
        } else {
          // decide cuál quedarte (elige la respuesta más larga)
          const mejor =
            (prev.respuesta?.length || 0) >= (f.respuesta?.length || 0) ? prev : f;
          byIntent.set(intent, mejor);
        }
      } else {
        sinIntent.push(f);
      }
    }
  
    // Elimina duplicados sin intención por similitud contra los ya elegidos
    const elegidas = Array.from(byIntent.values());
    const finales: FaqIn[] = [...elegidas];
  
    for (const f of sinIntent) {
      const dupPorSimilitud = finales.some((g) => esSimilar(f.pregunta, g.pregunta));
      if (!dupPorSimilitud) finales.push(f);
    }
    return finales;
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

    // 🔹 Dedup por intención/similitud ANTES de responder
    const filtradas = dedupeFaqs(rows as FaqIn[]);

    res.set("Cache-Control", "no-store");
    return res.status(200).json(filtradas);
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

    // 🔹 Normaliza, infiere intención si falta, y deduplica el payload entrante
    const preparados = dedupeFaqs(
        incoming
         .map((f) => ({
          pregunta: capitalizar(f.pregunta || ""),
          respuesta: (f.respuesta || "").toString().trim(),
          intencion:
            (f.intencion ? String(f.intencion).trim().toLowerCase() : null) ||
            inferirIntencion(f.pregunta || "") ||
            null,
          canal: canalDestino,
         }))
        .filter((f) => f.pregunta && f.respuesta)
      );

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
