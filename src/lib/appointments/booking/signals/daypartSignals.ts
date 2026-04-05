//src/lib/appointments/booking/signals/daypartSignals.ts
import { normalizeText } from "../shared/textCore";

export function detectDaypart(text: string): "morning" | "afternoon" | null {
  const t = normalizeText(text);

  if (
    /\b(manana|mañana|morning|temprano|por la manana|por la mañana|antes del mediodia|antes del mediodía)\b/i.test(t) ||
    /\b([1-9]|1[0-1])\s*(am|a\.m\.)\b/i.test(t)
  ) {
    return "morning";
  }

  if (
    /\b(tarde|afternoon|por la tarde|despues del mediodia|después del mediodía)\b/i.test(t) ||
    /\b(noche|evening|night|por la noche)\b/i.test(t) ||
    /\b(1[0-2]|[1-9])\s*(pm|p\.m\.)\b/i.test(t)
  ) {
    return "afternoon";
  }

  if (/\b(mas temprano|más temprano|tempranito|early)\b/i.test(t)) return "morning";
  if (/\b(mas tarde|más tarde|later)\b/i.test(t)) return "afternoon";

  return null;
}