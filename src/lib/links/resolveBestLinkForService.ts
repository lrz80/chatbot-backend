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

  if (options.length) {
    if (options.length === 1) return { ok: true, url: options[0].url };

    const t = String(userText || "").trim();

    if (t) {
      // 🚫 Si el input es solo un número, este resolver NO debe decidir.
      // El número pertenece al flujo conversacional superior.
      const isPureNumber = /^[1-9]$/.test(t);

      if (isPureNumber) {
        
      } else {
        const scored = options
          .map((o) => ({ ...o, score: scoreLabelVsText(o.label, t) }))
          .sort((a, b) => b.score - a.score);

        const best = scored[0];
        const second = scored[1];

        const strongEnough = best.score >= 0.40;
        const clearlyBetter = !second || best.score - second.score >= 0.12;

        if (strongEnough && clearlyBetter) {
          
          return { ok: true, url: best.url };
        }

        if (serviceUrl) {
          
          return { ok: true, url: serviceUrl };
        }

        const bestScore = Number(best?.score || 0);
        const secondScore = Number(second?.score || 0);

        if (bestScore <= 0 || bestScore === secondScore) {

          return {
            ok: false,
            reason: "ambiguous",
            options,
          };
        }

        return { ok: true, url: best.url };
      }
    }

    // Sin texto útil o con input numérico:
    // NO adivinamos variante aquí.
    if (serviceUrl) {
      
      return { ok: true, url: serviceUrl };
    }

    return {
      ok: false,
      reason: "ambiguous",
      options,
    };
  }

  if (serviceUrl) return { ok: true, url: serviceUrl };

  return { ok: false, reason: "no_link" };
}