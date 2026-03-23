// src/lib/fastpath/handlers/catalog/helpers/multiQuestionTypes.ts

export type MultiQuestionAttribute =
  | "price"
  | "includes"
  | "unknown";

export function normalizeMultiQuestionAttribute(
  value: string | null | undefined
): MultiQuestionAttribute {
  const v = String(value || "").trim().toLowerCase();

  if (v === "price") return "price";
  if (v === "includes") return "includes";

  return "unknown";
}