// src/utils/billingCycle.ts

/**
 * Devuelve el inicio del ciclo vigente (YYYY-MM-DD) dado un ancla (membresia_inicio).
 * Regla: el ciclo inicia cada mes en el mismo "día" del ancla; si el mes no tiene ese día,
 * se usa el último día del mes. Se calcula en UTC (ambos lados usarán este util).
 */
export function cycleStartForNow(anchorISO: string | Date, nowDate: Date = new Date()): string {
  const anchor = new Date(anchorISO);
  if (Number.isNaN(anchor.getTime())) {
    // fallback: primer día del mes actual (UTC)
    const y = nowDate.getUTCFullYear();
    const m = nowDate.getUTCMonth();
    const d = 1;
    return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  }

  const anchorDay = anchor.getUTCDate();           // 1..31
  const y = nowDate.getUTCFullYear();
  const m = nowDate.getUTCMonth();                 // 0..11
  const todayUTC = new Date(Date.UTC(y, m, nowDate.getUTCDate()));

  const daysIn = (yy: number, mmZeroBased: number) =>
    new Date(Date.UTC(yy, mmZeroBased + 1, 0)).getUTCDate();  // último día del mes

  // Candidato en mes actual (clamp por fin de mes)
  const dayThis = Math.min(anchorDay, daysIn(y, m));
  const candidateThis = new Date(Date.UTC(y, m, dayThis));

  // Candidato en mes anterior (clamp por fin de mes)
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 11 : m - 1;
  const dayPrev = Math.min(anchorDay, daysIn(prevY, prevM));
  const candidatePrev = new Date(Date.UTC(prevY, prevM, dayPrev));

  const ciclo = (todayUTC >= candidateThis) ? candidateThis : candidatePrev;
  return ciclo.toISOString().slice(0, 10);         // 'YYYY-MM-DD'
}
