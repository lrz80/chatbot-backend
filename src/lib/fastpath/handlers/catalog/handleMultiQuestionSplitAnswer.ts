// src/lib/fastpath/handlers/catalog/handleMultiQuestionSplitAnswer.ts
import type { Pool } from "pg";
import type { Lang } from "../../../channels/engine/clients/clientDb";

type QueryFrame = {
  raw: string;
  askedAttribute?: string | null;
  referencedEntityText?: string | null;
};

type ServiceMatch = {
  id?: string;
  serviceId?: string;
  name?: string;
  serviceName?: string;
  score?: number;
};

type PriceRow = {
  service_id: string;
  service_name: string;
  min_price: number | string | null;
  max_price: number | string | null;
  parent_service_id?: string | null;
  category?: string | null;
  catalog_role?: string | null;
};

type VariantRow = {
  id: string;
  variant_name: string | null;
  description: string | null;
  variant_url: string | null;
  price: number | string | null;
  currency: string | null;
};

type ServiceRow = {
  name: string | null;
  description: string | null;
  service_url: string | null;
};

type HandleMultiQuestionSplitAnswerInput = {
  userInput: string;
  idiomaDestino: Lang;
  tenantId: string;
  pool: Pool;
  intentOut?: string | null;

  extractQueryFrames: (input: string) => QueryFrame[];
  normalizeText: (input: string) => string;
  resolveServiceMatchesFromText: (
    pool: Pool,
    tenantId: string,
    text: string,
    opts?: any
  ) => Promise<ServiceMatch[]>;
  resolveServiceIdFromText: (
    pool: Pool,
    tenantId: string,
    text: string,
    opts?: any
  ) => Promise<any>;
  bestNameMatch: (input: string, list: any[]) => any;
  renderGenericPriceSummaryReply: (args: {
    lang: Lang;
    rows: any[];
  }) => string;
};

type HandleMultiQuestionSplitAnswerResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string;
};

function localTokens(normalizeText: (input: string) => string, raw: string): string[] {
  return normalizeText(String(raw || ""))
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const NOISE_TOKENS = new Set([
  "de","del","la","el","los","las","un","una","unos","unas",
  "para","por","en","y","o","u","a","que","q","este","esta",
  "ese","esa","esto","eso","le","lo","al","como","con","sin",
  "sobre","mi","tu","su","me","te","se",
  "the","a","an","and","or","to","for","in","of","what","does",
  "do","is","are","with","without","about","my","your","their",
  "me","you","it",
  "precio","precios","cuanto","cuanta","cuánto","cuánta",
  "cuesta","cuestan","vale","valen","costo","costos",
  "mensual","mensuales","mes","meses","mensualidad","desde",
  "price","prices","pricing","cost","costs","how","much",
  "monthly","month","months","from","starting","starts",
  "what","which","quiero","quieres","want","looking"
]);

async function loadTenantPriceRows(pool: Pool, tenantId: string): Promise<PriceRow[]> {
  const { rows } = await pool.query<PriceRow>(`
    WITH variant_prices AS (
      SELECT
        s.id AS service_id,
        s.name AS service_name,
        s.parent_service_id,
        s.category,
        s.catalog_role,
        MIN(v.price)::numeric AS min_price,
        MAX(v.price)::numeric AS max_price
      FROM services s
      JOIN service_variants v
        ON v.service_id = s.id
       AND v.active = true
      WHERE s.tenant_id = $1
        AND s.active = true
        AND v.price IS NOT NULL
      GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
    ),
    base_prices AS (
      SELECT
        s.id AS service_id,
        s.name AS service_name,
        s.parent_service_id,
        s.category,
        s.catalog_role,
        MIN(s.price_base)::numeric AS min_price,
        MAX(s.price_base)::numeric AS max_price
      FROM services s
      WHERE s.tenant_id = $1
        AND s.active = true
        AND s.price_base IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM service_variants v
          WHERE v.service_id = s.id
            AND v.active = true
            AND v.price IS NOT NULL
        )
      GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
    )
    SELECT
      service_id,
      service_name,
      min_price,
      max_price,
      parent_service_id,
      category,
      catalog_role
    FROM (
      SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM variant_prices
      UNION ALL
      SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM base_prices
    ) x
    ORDER BY
      CASE
        WHEN COALESCE(catalog_role, 'primary') = 'primary' THEN 0
        ELSE 1
      END,
      min_price ASC NULLS LAST,
      service_name ASC
  `, [tenantId]);

  return rows;
}

async function loadServiceVariants(pool: Pool, serviceId: string): Promise<VariantRow[]> {
  const { rows } = await pool.query<VariantRow>(
    `
    SELECT
      id,
      variant_name,
      description,
      variant_url,
      price,
      currency
    FROM service_variants
    WHERE service_id = $1
      AND active = true
    ORDER BY created_at ASC, id ASC
    `,
    [serviceId]
  );

  return rows;
}

export async function handleMultiQuestionSplitAnswer(
  input: HandleMultiQuestionSplitAnswerInput
): Promise<HandleMultiQuestionSplitAnswerResult> {
  const {
    userInput,
    idiomaDestino,
    tenantId,
    pool,
    intentOut,
    extractQueryFrames,
    normalizeText,
    resolveServiceMatchesFromText,
    resolveServiceIdFromText,
    bestNameMatch,
    renderGenericPriceSummaryReply,
  } = input;

  const frames = extractQueryFrames(userInput);

  if (!Array.isArray(frames) || frames.length < 2) {
    return { handled: false };
  }

  const subReplies: string[] = [];
  const seen = new Set<string>();

  for (const frame of frames.slice(0, 2)) {
    const part = String(frame?.raw || "").trim();
    const partNorm = normalizeText(part);
    if (!partNorm || seen.has(partNorm)) continue;
    seen.add(partNorm);

    const targetText = String(frame?.referencedEntityText || part).trim();

    console.log("[MULTIQ][PRICE] frame input", {
      raw: frame?.raw,
      referencedEntityText: frame?.referencedEntityText,
      targetText,
      askedAttribute: frame?.askedAttribute,
    });

    if (frame?.askedAttribute === "price") {
      const rows = await loadTenantPriceRows(pool, tenantId);

      const targetMatches = await resolveServiceMatchesFromText(
        pool,
        tenantId,
        targetText,
        {
          minScore: 0.3,
          maxResults: 6,
          relativeWindow: 0.2,
        }
      );

      const top1 = targetMatches[0] || null;
      const top2 = targetMatches[1] || null;

      const queryTokens = localTokens(normalizeText, targetText).filter(
        (t) => !NOISE_TOKENS.has(t)
      );
      const top1Tokens = top1 ? localTokens(normalizeText, String(top1.name || top1.serviceName || "")) : [];
      const top2Tokens = top2 ? localTokens(normalizeText, String(top2.name || top2.serviceName || "")) : [];

      const top1MeaningHits = queryTokens.filter((t) => top1Tokens.includes(t)).length;
      const top2MeaningHits = queryTokens.filter((t) => top2Tokens.includes(t)).length;

      const scoreGap =
        top1 && top2
          ? Number(top1.score || 0) - Number(top2.score || 0)
          : top1
          ? Number(top1.score || 0)
          : 0;

      const targetHit: ServiceMatch | null =
        top1 &&
        (
          targetMatches.length === 1 ||
          top1MeaningHits > top2MeaningHits ||
          (top1MeaningHits > 0 && scoreGap >= 0.05)
        )
          ? top1
          : null;

      console.log("[MULTIQ][PRICE] resolve attempt", {
        part,
        targetText,
        queryTokens,
        targetMatches,
        top1: top1
          ? {
              id: top1.id,
              name: top1.name,
              score: top1.score,
              meaningHits: top1MeaningHits,
            }
          : null,
        top2: top2
          ? {
              id: top2.id,
              name: top2.name,
              score: top2.score,
              meaningHits: top2MeaningHits,
            }
          : null,
        scoreGap,
        targetHit: targetHit
          ? {
              serviceId: targetHit.serviceId || targetHit.id,
              serviceName: targetHit.serviceName || targetHit.name,
            }
          : null,
      });

      if (!targetHit && targetMatches.length >= 2) {
        const matchedPriceLines = targetMatches
          .map((m) => {
            const matchId = String(m.serviceId || m.id || "");
            const row = rows.find((r) => String(r.service_id) === matchId);
            if (!row) return null;

            const min = row.min_price === null ? null : Number(row.min_price);
            const max = row.max_price === null ? null : Number(row.max_price);

            let priceText =
              idiomaDestino === "en" ? "price available" : "precio disponible";

            if (Number.isFinite(min) && Number.isFinite(max)) {
              priceText =
                min === max
                  ? `$${min}`
                  : `${idiomaDestino === "en" ? "from" : "desde"} $${min}`;
            }

            return `• ${row.service_name}: ${priceText}`;
          })
          .filter(Boolean) as string[];

        if (matchedPriceLines.length) {
          subReplies.push(matchedPriceLines.join("\n"));
          continue;
        }
      }

      if (targetHit) {
        const targetServiceId = String(targetHit.serviceId || targetHit.id || "");
        const targetServiceName = String(
          targetHit.serviceName || targetHit.name || ""
        ).trim();

        const variants = await loadServiceVariants(pool, targetServiceId);

        let chosenVariant: VariantRow | null = null;

        if (variants.length > 0) {
          const matchedVariant = bestNameMatch(
            part,
            variants.map((v) => ({
              id: String(v.id),
              name: String(v.variant_name || "").trim(),
              url: v.variant_url ? String(v.variant_url).trim() : null,
            }))
          );

          if (matchedVariant?.id) {
            chosenVariant =
              variants.find((v) => String(v.id) === String(matchedVariant.id)) || null;
          }
        }

        if (chosenVariant) {
          const priceNum =
            chosenVariant.price === null ||
            chosenVariant.price === undefined ||
            chosenVariant.price === ""
              ? null
              : Number(chosenVariant.price);

          const baseName = targetServiceName || "";
          const variantName = String(chosenVariant.variant_name || "").trim();
          const link = chosenVariant.variant_url
            ? String(chosenVariant.variant_url).trim()
            : null;

          let block =
            idiomaDestino === "en"
              ? `• ${baseName} — ${variantName}: ${
                  Number.isFinite(priceNum) ? `$${priceNum}` : "price available"
                }`
              : `• ${baseName} — ${variantName}: ${
                  Number.isFinite(priceNum) ? `$${priceNum}` : "precio disponible"
                }`;

          if (link) block += `\n  Link: ${link}`;

          subReplies.push(block);
          continue;
        }

        if (variants.length > 0) {
          const lines = variants
            .map((v) => {
              const numPrice =
                v.price === null || v.price === undefined || v.price === ""
                  ? NaN
                  : Number(v.price);
              const label = String(v.variant_name || "").trim();

              return Number.isFinite(numPrice)
                ? `• ${targetServiceName} — ${label}: $${numPrice}`
                : `• ${targetServiceName} — ${label}`;
            })
            .slice(0, 4);

          if (lines.length) {
            subReplies.push(lines.join("\n"));
            continue;
          }
        }

        const row = rows.find(
          (r) =>
            normalizeText(String(r.service_name || "")) ===
            normalizeText(targetServiceName)
        );

        if (row) {
          const min = row.min_price === null ? null : Number(row.min_price);
          const max = row.max_price === null ? null : Number(row.max_price);

          let priceText =
            idiomaDestino === "en" ? "price available" : "precio disponible";

          if (Number.isFinite(min) && Number.isFinite(max)) {
            priceText =
              min === max
                ? `$${min}`
                : `${idiomaDestino === "en" ? "from" : "desde"} $${min}`;
          }

          subReplies.push(`• ${targetServiceName}: ${priceText}`);
          continue;
        }
      }

      const compact = renderGenericPriceSummaryReply({
        lang: idiomaDestino,
        rows: rows.slice(0, 5),
      });
      subReplies.push(compact);
      continue;
    }

    if (frame?.askedAttribute === "includes") {
      const hit = await resolveServiceIdFromText(pool, tenantId, targetText, {
        mode: "loose",
      });

      if (hit) {
        const serviceId = String(hit.serviceId || hit.id || "");
        const serviceName = String(hit.serviceName || hit.name || "").trim();

        const variants = await loadServiceVariants(pool, serviceId);

        if (variants.length > 0) {
          const matchedVariant = bestNameMatch(
            part,
            variants.map((v) => ({
              id: String(v.id),
              name: String(v.variant_name || "").trim(),
              url: v.variant_url ? String(v.variant_url).trim() : null,
            }))
          );

          if (matchedVariant?.id) {
            const chosen =
              variants.find((v) => String(v.id) === String(matchedVariant.id)) || null;

            if (chosen) {
              const descSource = String(chosen.description || "").trim();
              const link = chosen.variant_url
                ? String(chosen.variant_url).trim()
                : null;

              let block = `• ${serviceName} — ${String(chosen.variant_name || "").trim()}`;
              if (descSource) block += `\n  ${descSource}`;
              if (link) block += `\n  Link: ${link}`;

              subReplies.push(block);
              continue;
            }
          }
        }

        const {
          rows: [service],
        } = await pool.query<ServiceRow>(
          `
          SELECT name, description, service_url
          FROM services
          WHERE id = $1
          `,
          [serviceId]
        );

        const desc = String(service?.description || "").trim();
        const link = service?.service_url ? String(service.service_url).trim() : null;

        let block = `• ${serviceName}`;
        if (desc) block += `\n  ${desc}`;
        if (link) block += `\n  Link: ${link}`;

        subReplies.push(block);
        continue;
      }
    }
  }

  if (subReplies.length >= 2) {
    const intro =
      idiomaDestino === "en"
        ? "Here’s what I found:"
        : "Esto fue lo que conseguí 😊";

    return {
      handled: true,
      reply: `${intro}\n\n${subReplies.join("\n\n")}`,
      source: "service_list_db",
      intent: intentOut || "info_servicio",
    };
  }

  return { handled: false };
}