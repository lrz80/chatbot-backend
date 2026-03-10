// backend/src/lib/estimateFlow/isEstimateStarterMessage.ts

export function isEstimateStarterMessage(userInput: string): boolean {
  const t = String(userInput || "").toLowerCase().trim();

  return (
    /\bestimado\b/.test(t) ||
    /\bestimate\b/.test(t) ||
    /\bquote\b/.test(t) ||
    /\bcotizacion\b/.test(t) ||
    /\bcotización\b/.test(t) ||
    /\bagendar estimado\b/.test(t) ||
    /\bschedule estimate\b/.test(t) ||
    /\bfree estimate\b/.test(t) ||
    /\bon site estimate\b/.test(t) ||
    /\bvisita\b/.test(t)
  );
}