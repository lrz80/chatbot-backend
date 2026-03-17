import type { Pool } from "pg";

type LinkPick =
  | { ok: true; url: string }
  | { ok: false; reason: "no_link" }
  | { ok: false; reason: "ambiguous"; options: Array<{ label: string; url: string }> };

function norm(s: string) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenize(s: string) {
  return norm(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 2);
}

// Similitud simple por overlap (sin hardcode de keywords)
function scoreLabelVsText(label: string, userText: string) {
  const a = new Set(tokenize(label));
  const b = new Set(tokenize(userText));
  if (!a.size || !b.size) return 0;

  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;

  // Jaccard
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export async function resolveBestLinkForService(args: {
  pool: Pool;
  tenantId: string;
  serviceId: string;
  userText?: string | null;
}): Promise<LinkPick> {
  const { pool, tenantId, serviceId, userText } = args;

  console.log("🔗 [LINK-RESOLVER] start", {
    tenantId,
    serviceId,
    userText,
  });

  // 1) Cargar service_url (pero NO devolverlo todavía)
  const s = await pool.query(
    `
    SELECT NULLIF(TRIM(COALESCE(service_url,'')), '') AS service_url
    FROM services
    WHERE tenant_id = $1 AND id = $2 AND active = true
    LIMIT 1
    `,
    [tenantId, serviceId]
  );
  const serviceUrl = s.rows?.[0]?.service_url ? String(s.rows[0].service_url) : "";

  console.log("🔗 [LINK-RESOLVER] service row", {
    serviceUrl,
  });

  // 2) variant_url(s)  ✅ multitenant-safe
  const v = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(TRIM(COALESCE(v.variant_name,'')), ''), 'Option') AS label,
      NULLIF(TRIM(COALESCE(v.variant_url,'')), '') AS url
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND s.id = $2
      AND COALESCE(v.active, true) = true
      AND NULLIF(TRIM(COALESCE(v.variant_url,'')), '') IS NOT NULL
    ORDER BY
      v.updated_at DESC NULLS LAST,
      v.created_at DESC
    `,
    [tenantId, serviceId]
  );

  const options = (v.rows || [])
    .map((r: any) => ({
      label: String(r.label || "Option").trim(),
      url: String(r.url || "").trim(),
    }))
    .filter((o) => o.url);

  // ===============================
  // ✅ PRIORIDAD 0: selección numérica directa
  // ===============================
  const rawInput = String(userText || "").trim();
  const numericIndex = parseInt(rawInput, 10);

  if (
    Number.isFinite(numericIndex) &&
    numericIndex >= 1 &&
    numericIndex <= options.length
  ) {
    const selected = options[numericIndex - 1];

    console.log("🔗 [LINK-RESOLVER] numeric selection detected", {
      userText,
      index: numericIndex,
      selected: selected?.label,
    });

    return {
      ok: true,
      url: selected.url,
    };
  }

  // ✅ Si hay variantes con URL, intentamos usarla primero
  if (options.length) {
    // Si solo hay 1, listo
    if (options.length === 1) return { ok: true, url: options[0].url };

    const t = String(userText || "").trim();
    if (t) {
      // Pick por similitud label<->texto
      const scored = options
        .map((o) => ({ ...o, score: scoreLabelVsText(o.label, t) }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      const second = scored[1];

      console.log("🔗 [LINK-RESOLVER] scored options", {
        scored,
        best,
        second,
      });

      // Umbrales (genéricos): debe haber match decente y no ser empate
      const strongEnough = best.score >= 0.40; // ajustable
      const clearlyBetter = !second || best.score - second.score >= 0.12;

      // Caso 1: coincidencia clara => variante específica
      if (strongEnough && clearlyBetter) {
        console.log("🔗 [LINK-RESOLVER] strong match -> best.variant", {
          url: best.url,
        });
        return { ok: true, url: best.url };
      }

      // Caso 2: ambigüedad pero el servicio tiene service_url genérico
      if (serviceUrl) {
        console.log("🔗 [LINK-RESOLVER] ambiguous but has serviceUrl -> fallback service", {
          url: serviceUrl,
        });
        return { ok: true, url: serviceUrl };
      }

      // 🚨 Caso 3: ambigüedad real y NO hay service_url
      const bestScore = Number(best?.score || 0);
      const secondScore = Number(second?.score || 0);

      if (bestScore <= 0 || bestScore === secondScore) {
        console.log("🔗 [LINK-RESOLVER] ambiguous -> ask variant", {
          options,
        });

        return {
          ok: false,
          reason: "ambiguous",
          options,
        };
      }

      // si no es empate y hay leve señal, usamos la mejor
      console.log("🔗 [LINK-RESOLVER] weak but usable match -> best.variant", {
        url: best.url,
      });

      return { ok: true, url: best.url };
    }

    // ===========================
    // Sin userText:
    // ===========================
    if (serviceUrl) {
      console.log("🔗 [LINK-RESOLVER] no variants, using serviceUrl", {
        url: serviceUrl,
      });
      return { ok: true, url: serviceUrl };
    }

    // sin service_url: usar la primera variante como fallback
    return { ok: true, url: options[0].url };
  }

  // 3) Sin variantes -> usar service_url si existe
  if (serviceUrl) return { ok: true, url: serviceUrl };

  console.log("🔗 [LINK-RESOLVER] no link found at all");
  return { ok: false, reason: "no_link" };
}