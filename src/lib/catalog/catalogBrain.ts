import type { Pool } from "pg";
import type { CatalogResult, Lang } from "./types";
import { detectCatalogNeed } from "./isCatalogQuestion";
import { resolveCatalogFromDb } from "./resolveCatalogFromDb";

function asksPlans(text: string) {
  const t = String(text || "").toLowerCase();
  return /\b(plan|planes|membres(i|í)a|membresias|paquete|paquetes|membership|memberships|plans|packages)\b/.test(t);
}

function hasStickyLastRef(lastRef: any) {
  return Boolean(lastRef?.service_id || lastRef?.variant_id);
}

export async function catalogBrain(args: {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: Lang;
  convoCtx: any;
}): Promise<CatalogResult> {
  const { pool, tenantId, userInput, idiomaDestino, convoCtx } = args;

  const need = detectCatalogNeed(userInput, idiomaDestino);
  if (!need) return { hit: false };

  const lastRef = convoCtx?.last_service_ref;

  // =====================================================
  // ✅ GATE A: "precios" sin especificar -> mostrar PLANES
  // =====================================================
  // Regla: si el usuario pide precio pero NO especifica item
  // y tampoco hay last_service_ref, damos un resumen de planes.
  if ((need === "price" || need === "any") && !hasStickyLastRef(lastRef)) {
    const plans = await fetchPlanNames(pool, tenantId);

    if (plans.length) {
      const top = plans.slice(0, 7);

      const ask =
        idiomaDestino === "en"
          ? `These are our main plans:\n${top.map((p) => `- ${p}`).join("\n")}\n\nWhich plan are you interested in?`
          : `Estos son nuestros planes principales:\n${top.map((p) => `- ${p}`).join("\n")}\n\n¿Cuál plan te interesa?`;

      return {
        hit: true,
        status: "needs_clarification",
        need: "price",
        ask,
      };
    }
    // Si no hay planes en DB, dejamos que el resolver haga su trabajo normal
  }

  // =====================================================
  // ✅ GATE B: "¿qué planes tienes?" -> SIEMPRE planes (no servicios)
  // =====================================================
  if (need === "list" && asksPlans(userInput)) {
    const plans = await fetchPlanNames(pool, tenantId);

    if (plans.length) {
      const top = plans.slice(0, 7);

      const ask =
        idiomaDestino === "en"
          ? `Here are our plans:\n${top.map((p) => `- ${p}`).join("\n")}\n\nWhich one interests you?`
          : `Estos son nuestros planes:\n${top.map((p) => `- ${p}`).join("\n")}\n\n¿Cuál te interesa?`;

      return {
        hit: true,
        status: "needs_clarification",
        need: "list",
        ask,
      };
    }
    // Si no hay planes en DB, cae al resolver normal (servicios/lo que haya)
  }

  // =====================================================
  // Resolver normal (DB-first)
  // =====================================================
  return await resolveCatalogFromDb({
    pool,
    tenantId,
    userInput,
    need,
    idioma: idiomaDestino,
    lastRef,
  });
}

async function fetchPlanNames(pool: any, tenantId: string) {
  const { rows } = await pool.query(
    `
    SELECT name
    FROM services
    WHERE tenant_id = $1
      AND active = true
      AND COALESCE(tipo,'service') = 'plan'
    ORDER BY COALESCE(sort_order, 9999) ASC, name ASC
    `,
    [tenantId]
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const s = String(r?.name || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
