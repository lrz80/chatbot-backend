// src/lib/fastpath/handlers/catalog/handleMultiQuestionSplitAnswer.ts
import type { Pool } from "pg";
import type { Lang } from "../../../channels/engine/clients/clientDb";

import {
  normalizeMultiQuestionAttribute,
} from "./helpers/multiQuestionTypes";
import {
  localTokens,
  MULTI_QUESTION_NOISE_TOKENS,
} from "./helpers/multiQuestionText";
import {
  getMultiQuestionFromLabel,
  getMultiQuestionIntro,
  getMultiQuestionLinkLabel,
  getMultiQuestionPriceAvailableLabel,
} from "./helpers/multiQuestionRender";

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

  answerCatalogQuestionLLM: (input: {
    idiomaDestino: "es" | "en";
    canonicalReply: string;
    userInput: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string | null>;

  renderCatalogReplyWithSalesFrame: (args: {
    lang: Lang;
    userInput: string;
    canonicalReply: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    answerCatalogQuestionLLM: (input: {
      idiomaDestino: "es" | "en";
      canonicalReply: string;
      userInput: string;
      mode?: "grounded_frame_only" | "grounded_catalog_sales";
      maxIntroLines?: number;
      maxClosingLines?: number;
    }) => Promise<string | null>;
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string>;
};

type HandleMultiQuestionSplitAnswerResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string;
};

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

function normalizeAskedAttribute(
  value: string | null | undefined
): "price" | "includes" | "unknown" {
  const v = String(value || "").trim().toLowerCase();
  if (v === "price") return "price";
  if (v === "includes") return "includes";
  return "unknown";
}

function formatPriceText(
  idiomaDestino: Lang,
  min: number | null,
  max: number | null
): string {
  if (!Number.isFinite(min) && !Number.isFinite(max)) {
    return idiomaDestino === "en" ? "price available" : "precio disponible";
  }

  if (Number.isFinite(min) && Number.isFinite(max)) {
    return min === max
      ? `$${min}`
      : `${idiomaDestino === "en" ? "from" : "desde"} $${min}`;
  }

  const fallback = Number.isFinite(min) ? min : max;
  return Number.isFinite(fallback)
    ? `$${fallback}`
    : idiomaDestino === "en"
    ? "price available"
    : "precio disponible";
}

function formatLinkLine(link: string | null): string {
  return link ? `\n  Link: ${link}` : "";
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
    answerCatalogQuestionLLM,
    renderCatalogReplyWithSalesFrame,
  } = input;

  const frames = extractQueryFrames(userInput);

  if (!Array.isArray(frames) || frames.length < 2) {
    return { handled: false };
  }

  const candidateFrames = frames
    .slice(0, 2)
    .map((frame) => {
      const part = String(frame?.raw || "").trim();
      const partNorm = normalizeText(part);
      const targetText = String(frame?.referencedEntityText || part).trim();
      const askedAttribute = normalizeAskedAttribute(frame?.askedAttribute);

      return {
        frame,
        part,
        partNorm,
        targetText,
        askedAttribute,
      };
    })
    .filter((x) => x.partNorm && x.targetText && x.askedAttribute !== "unknown");

  if (candidateFrames.length < 2) {
    return { handled: false };
  }

  const uniqueParts = new Set(candidateFrames.map((x) => x.partNorm));
  if (uniqueParts.size < 2) {
    return { handled: false };
  }

  const subReplies: string[] = [];

  for (const item of candidateFrames) {
    const { part, targetText, askedAttribute } = item;

    if (askedAttribute === "price") {
      const rows = await loadTenantPriceRows(pool, tenantId);

      const targetMatches = await resolveServiceMatchesFromText(
        pool,
        tenantId,
        targetText,
        {
          minScore: 0.45,
          maxResults: 3,
          relativeWindow: 0.12,
        }
      );

      const top1 = targetMatches[0] || null;
      const top2 = targetMatches[1] || null;

      const top1Score = top1 ? Number(top1.score || 0) : 0;
      const top2Score = top2 ? Number(top2.score || 0) : 0;
      const scoreGap = top1Score - top2Score;

      const hasConfidentSingleHit =
        Boolean(top1) &&
        (
          targetMatches.length === 1 ||
          (top1Score >= 0.6 && scoreGap >= 0.12)
        );

      if (!hasConfidentSingleHit || !top1) {
        return { handled: false };
      }

      const targetServiceId = String(top1.serviceId || top1.id || "");
      const targetServiceName = String(
        top1.serviceName || top1.name || ""
      ).trim();

      if (!targetServiceId || !targetServiceName) {
        return { handled: false };
      }

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

        const variantName = String(chosenVariant.variant_name || "").trim();
        const link = chosenVariant.variant_url
          ? String(chosenVariant.variant_url).trim()
          : null;

        const block =
          `• ${targetServiceName} — ${variantName}: ${
            Number.isFinite(priceNum)
              ? `$${priceNum}`
              : (idiomaDestino === "en" ? "price available" : "precio disponible")
          }` + formatLinkLine(link);

        subReplies.push(block);
        continue;
      }

      const row = rows.find(
        (r) => String(r.service_id) === targetServiceId
      );

      if (!row) {
        return { handled: false };
      }

      const min = row.min_price === null ? null : Number(row.min_price);
      const max = row.max_price === null ? null : Number(row.max_price);

      subReplies.push(`• ${targetServiceName}: ${formatPriceText(idiomaDestino, min, max)}`);
      continue;
    }

    if (askedAttribute === "includes") {
      const hit = await resolveServiceIdFromText(pool, tenantId, targetText, {
        mode: "loose",
      });

      const serviceId = String(hit?.serviceId || hit?.id || "");
      const serviceName = String(hit?.serviceName || hit?.name || "").trim();

      if (!serviceId || !serviceName) {
        return { handled: false };
      }

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
            block += formatLinkLine(link);

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
      block += formatLinkLine(link);

      subReplies.push(block);
      continue;
    }

    return { handled: false };
  }

  if (subReplies.length < 2) {
    return { handled: false };
  }

  const canonicalReply = subReplies.join("\n\n");

  const reply = await renderCatalogReplyWithSalesFrame({
    lang: idiomaDestino,
    userInput,
    canonicalReply,
    answerCatalogQuestionLLM,
    mode: "grounded_catalog_sales",
    maxIntroLines: 1,
    maxClosingLines: 1,
  });

  return {
    handled: true,
    reply,
    source: "service_list_db",
    intent: intentOut || "info_servicio",
  };
}