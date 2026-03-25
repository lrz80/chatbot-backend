// src/lib/fastpath/helpers/catalogRendering.ts
import type { Lang } from "../../channels/engine/clients/clientDb";

export type CatalogRenderingMode =
  | "grounded_frame_only"
  | "grounded_catalog_sales";

export async function renderCatalogReplyWithSalesFrame(args: {
  lang: Lang;
  userInput: string;
  canonicalReply: string;
  mode?: CatalogRenderingMode;
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
}): Promise<string> {
  const {
    lang,
    userInput,
    canonicalReply,
    answerCatalogQuestionLLM,
    mode = "grounded_catalog_sales",
    maxIntroLines = 1,
    maxClosingLines = 1,
  } = args;

  const canonical = String(canonicalReply || "").trim();
  if (!canonical) return "";

  const llmReply = await answerCatalogQuestionLLM({
    idiomaDestino: lang === "en" ? "en" : "es",
    canonicalReply: canonical,
    userInput: String(userInput || "").trim(),
    mode,
    maxIntroLines,
    maxClosingLines,
  });

  return String(llmReply || canonical).trim();
}

export async function renderFreeOfferList(args: {
  lang: Lang;
  userInput: string;
  items: { name: string }[];
  answerCatalogQuestionLLM: (input: {
    idiomaDestino: "es" | "en";
    canonicalReply: string;
    userInput: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string | null>;
}): Promise<string> {
  const { lang, userInput, items, answerCatalogQuestionLLM } = args;

  const canonicalReply = items
    .slice(0, 6)
    .map((x, i) => `• ${i + 1}) ${String(x.name || "").trim()}`)
    .filter(Boolean)
    .join("\n");

  if (!canonicalReply) return "";

  return renderCatalogReplyWithSalesFrame({
    lang,
    userInput,
    canonicalReply,
    answerCatalogQuestionLLM,
    mode: "grounded_catalog_sales",
    maxIntroLines: 1,
    maxClosingLines: 1,
  });
}