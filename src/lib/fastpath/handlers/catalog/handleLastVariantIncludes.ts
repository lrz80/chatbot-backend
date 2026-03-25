import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";
import { getCatalogDetailSignals } from "./getCatalogDetailSignals";

export type HandleLastVariantIncludesInput = {
  pool: Pool;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
  detectedIntent?: string | null;
  intentOut?: string | null;
  catalogReferenceClassification?: any;
  traducirMensaje: (texto: string, idiomaDestino: string) => Promise<string>;
  answerCatalogQuestionLLM: (input: {
    idiomaDestino: "es" | "en";
    canonicalReply: string;
    userInput: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string | null>;
  renderCatalogReplyWithSalesFrame: (args: {
    lang: any;
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

export async function handleLastVariantIncludes(
  input: HandleLastVariantIncludesInput
): Promise<FastpathResult> {
  const {
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
  });

  const {
    looksLikeExplicitDetail,
  } = getCatalogDetailSignals({
    detectedIntent: input.detectedIntent,
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
  });

  const now = Date.now();
  const variantTtlMs = 10 * 60 * 1000;

  const lastVariantId = String(input.convoCtx?.last_variant_id || "").trim();
  const lastVariantAt = Number(input.convoCtx?.last_variant_at || 0);

  const lastVariantFresh =
    !!lastVariantId &&
    Number.isFinite(lastVariantAt) &&
    lastVariantAt > 0 &&
    now - lastVariantAt <= variantTtlMs;

  const hasExplicitStructuredTarget = Boolean(
    targetServiceId || targetVariantId || targetFamilyKey
  );

  const isGenericIncludesFollowup =
    looksLikeExplicitDetail && !hasExplicitStructuredTarget;

  if (!(isGenericIncludesFollowup && lastVariantFresh)) {
    return {
      handled: false,
    };
  }

  const { rows: variantRows } = await input.pool.query<any>(
    `
    SELECT
      v.id,
      v.service_id,
      v.variant_name,
      v.description,
      v.variant_url,
      s.name AS service_name,
      s.description AS service_description,
      s.service_url
    FROM service_variants v
    JOIN services s
      ON s.id = v.service_id
    WHERE v.id = $1
      AND v.active = true
    LIMIT 1
    `,
    [lastVariantId]
  );

  const chosen = variantRows[0];

  if (!chosen) {
    return {
      handled: false,
    };
  }

  const baseName = String(chosen.service_name || "").trim();
  const variantName = String(chosen.variant_name || "").trim();

  const descSource = String(
    chosen.description || chosen.service_description || ""
  ).trim();

  const link =
    chosen.variant_url
      ? String(chosen.variant_url).trim()
      : chosen.service_url
      ? String(chosen.service_url).trim()
      : null;

  let displayBaseName = baseName;
  let displayVariantName = variantName;
  let displayBullets = descSource;

  if (input.idiomaDestino === "en") {
    try {
      if (displayBaseName) {
        displayBaseName = await input.traducirMensaje(displayBaseName, "en");
      }
    } catch (e) {
      console.warn(
        "[FASTPATH-INCLUDES] error traduciendo service_name desde last_variant:",
        e
      );
    }

    try {
      if (displayVariantName) {
        displayVariantName = await input.traducirMensaje(displayVariantName, "en");
      }
    } catch (e) {
      console.warn(
        "[FASTPATH-INCLUDES] error traduciendo variant_name desde last_variant:",
        e
      );
    }

    try {
      if (displayBullets) {
        const bulletList: string[] = displayBullets
          .split(/\r?\n/)
          .map((l: string) => l.trim())
          .filter((l: string) => l.length > 0);

        const translated: string[] = [];
        for (const b of bulletList) {
          translated.push(await input.traducirMensaje(b, "en"));
        }

        displayBullets = translated.join("\n");
      }
    } catch (e) {
      console.warn(
        "[FASTPATH-INCLUDES] error traduciendo bullets desde last_variant:",
        e
      );
    }
  }

  const bullets =
    displayBullets
      ? displayBullets
          .split(/\r?\n/)
          .map((l: string) => l.trim())
          .filter((l: string) => l.length > 0)
          .map((l: string) => `• ${l}`)
          .join("\n")
      : "";

  const title =
    displayBaseName && displayVariantName
      ? `${displayBaseName} — ${displayVariantName}`
      : displayBaseName || displayVariantName || "";

  const canonicalLines = [
    title ? `• ${title}` : "",
    bullets || "",
    link ? `• ${link}` : "",
  ].filter(Boolean);

  const canonicalReply = canonicalLines.join("\n\n");

  const reply = await input.renderCatalogReplyWithSalesFrame({
    lang: input.idiomaDestino === "en" ? "en" : "es",
    userInput: input.userInput,
    canonicalReply,
    answerCatalogQuestionLLM: input.answerCatalogQuestionLLM,
    mode: "grounded_catalog_sales",
    maxIntroLines: 1,
    maxClosingLines: 1,
  });

  console.log("[FASTPATH-INCLUDES] using last_variant_id directly", {
    userInput: input.userInput,
    lastVariantId,
    serviceId: chosen.service_id,
    baseName,
    variantName,
    link,
  });

  return {
    handled: true,
    reply,
    source: "service_list_db",
    intent: input.intentOut || "info_servicio",
    ctxPatch: {
      selectedServiceId: String(chosen.service_id || ""),
      expectingVariant: false,
      expectedVariantIntent: null,

      last_service_id: String(chosen.service_id || ""),
      last_service_name: baseName || null,
      last_service_at: Date.now(),

      last_variant_id: String(chosen.id || ""),
      last_variant_name: variantName || null,
      last_variant_url: link || null,
      last_variant_at: Date.now(),
    } as any,
  };
}