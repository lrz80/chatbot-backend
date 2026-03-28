import type { Lang } from "../../channels/engine/clients/clientDb";

export type CatalogRenderingMode =
  | "grounded_frame_only"
  | "grounded_catalog_sales";

export async function renderCatalogReplyWithSalesFrame(args: {
  lang: Lang;
  userInput: string;
  canonicalReply: string;
  mode?: CatalogRenderingMode;
  maxIntroLines?: number;
  maxClosingLines?: number;
}): Promise<string> {
  const { canonicalReply } = args;

  const canonical = String(canonicalReply || "").trim();
  if (!canonical) return "";

  return canonical;
}

export async function renderFreeOfferList(args: {
  lang: Lang;
  userInput: string;
  items: { name: string }[];
}): Promise<string> {
  const { items } = args;

  const canonicalReply = items
    .slice(0, 6)
    .map((x, i) => `• ${i + 1}) ${String(x.name || "").trim()}`)
    .filter(Boolean)
    .join("\n");

  if (!canonicalReply) return "";

  return canonicalReply;
}