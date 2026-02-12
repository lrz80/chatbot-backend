import type { PriceContext, PriceInfo } from "./types";

export function buildPriceContext(args: {
  serviceName?: string | null;
  priceInfo: PriceInfo;
}): PriceContext | null {
  const { serviceName, priceInfo } = args;

  if (!priceInfo.ok) return null;

  return {
    serviceName: serviceName ?? null,
    mode: priceInfo.mode,
    amount: priceInfo.amount,
    currency: (priceInfo.currency || "USD").toUpperCase(),
    options: "options" in priceInfo ? priceInfo.options : undefined,
    optionsCount: "optionsCount" in priceInfo ? priceInfo.optionsCount : undefined,
  };
}
