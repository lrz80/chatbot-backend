import type { Pool } from "pg";
import { scoreCandidate } from "./scoring";

export type VariantPickResult =
  | {
      ok: true;
      resolved: {
        ok: true;
        kind: "variant";
        label: string;
        url: string | null;
        price: number | null;
        currency: string | null;
        duration_min: number | null;
        description: string | null;
        service_id: string;
        variant_id: string;
      };
    }
  | {
      ok: false;
      reason: "no_match" | "ambiguous";
      options?: Array<{
        label: string;
        kind: "variant";
        service_id: string;
        variant_id: string;
      }>;
    };

export async function pickVariantFromServiceContext(args: {
  pool: Pool;
  tenantId: string;
  serviceId: string;
  userPickText: string;
  limit?: number;
}): Promise<VariantPickResult> {
  const { pool, tenantId, serviceId } = args;
  const userPickText = String(args.userPickText || "").trim();
  const limit = Math.min(Math.max(Number(args.limit || 5), 3), 8);

  if (!tenantId || !serviceId || !userPickText) return { ok: false, reason: "no_match" };

  const { rows } = await pool.query(
    `
    SELECT
      s.id AS service_id,
      s.name AS service_name,
      s.description AS service_desc,
      s.duration_min AS service_duration,
      s.service_url AS service_url,

      v.id AS variant_id,
      v.variant_name,
      v.description AS variant_desc,
      v.duration_min AS variant_duration,
      v.price AS variant_price,
      COALESCE(v.currency, 'USD') AS variant_currency,
      COALESCE(v.variant_url, s.service_url) AS url
    FROM services s
    JOIN service_variants v ON v.service_id = s.id
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND v.active = TRUE
      AND s.id = $2
      AND v.price IS NOT NULL
    ORDER BY v.updated_at DESC NULLS LAST, v.created_at DESC NULLS LAST
    `,
    [tenantId, serviceId]
  );

  const candidates = (rows || []).map((r: any) => ({
    r,
    label: `${r.service_name} - ${r.variant_name}`,
    score: scoreCandidate(userPickText, `${r.service_name} - ${r.variant_name}`),
  }));

  if (!candidates.length) return { ok: false, reason: "no_match" };

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const second = candidates[1];

  if (!best || best.score < 3) return { ok: false, reason: "no_match" };

  // ambiguous si muy cercano
  if (second && second.score >= best.score * 0.92) {
    const top = candidates.slice(0, limit).map((x) => ({
      label: x.label,
      kind: "variant" as const,
      service_id: String(x.r.service_id),
      variant_id: String(x.r.variant_id),
    }));

    return { ok: false, reason: "ambiguous", options: top };
  }

  const r = best.r;

  const resolved = {
    ok: true as const,
    kind: "variant" as const,
    label: `${r.service_name} - ${r.variant_name}`,
    url: r.url || null,
    price: r.variant_price != null ? Number(r.variant_price) : null,
    currency: r.variant_currency ? String(r.variant_currency) : "USD",
    duration_min:
      r.variant_duration != null
        ? Number(r.variant_duration)
        : r.service_duration != null
          ? Number(r.service_duration)
          : null,
    description:
      r.variant_desc && String(r.variant_desc).trim()
        ? String(r.variant_desc)
        : r.service_desc
          ? String(r.service_desc)
          : null,
    service_id: String(r.service_id),
    variant_id: String(r.variant_id),
  };

  return { ok: true, resolved };
}
