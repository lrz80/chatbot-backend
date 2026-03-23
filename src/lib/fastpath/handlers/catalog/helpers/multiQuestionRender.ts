// src/lib/fastpath/handlers/catalog/helpers/multiQuestionRender.ts
import type { Lang } from "../../../../channels/engine/clients/clientDb";

export function getMultiQuestionPriceAvailableLabel(lang: Lang): string {
  return lang === "en" ? "price available" : "precio disponible";
}

export function getMultiQuestionFromLabel(lang: Lang): string {
  return lang === "en" ? "from" : "desde";
}

export function getMultiQuestionLinkLabel(lang: Lang): string {
  return lang === "en" ? "Link" : "Link";
}

export function getMultiQuestionIntro(lang: Lang): string {
  return lang === "en"
    ? "Here’s what I found:"
    : "Esto fue lo que conseguí 😊";
}