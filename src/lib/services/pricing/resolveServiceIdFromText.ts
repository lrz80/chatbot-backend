// src/lib/services/pricing/resolveServiceIdFromText.ts

import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirMensaje } from "../../traducirMensaje";

type Hit = { id: string; name: string };

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string
): Promise<Hit | null> {

  let t = String(userText || "").trim();
  if (!t) return null;

  const idioma = await detectarIdioma(t).catch(() => "es");

  const normalize = (s: string) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const tNormRaw = normalize(t);

  // Traducción cruzada (ES <-> EN)
  let tAlt = tNormRaw;
  try {
    if (idioma === "es") tAlt = normalize(await traducirMensaje(t, "en"));
    else if (idioma === "en") tAlt = normalize(await traducirMensaje(t, "es"));
  } catch {
    // fallback silencioso
  }

  // STOPWORDS genéricas (NO industria)
  const STOP = new Set([
    // artículos / conectores ES
    "de","del","la","el","los","las","un","una","unos","unas",
    "para","por","en","y","o","a",
    // artículos / conectores EN
    "the","a","an","and","or","to","for","in","of",
    // precio
    "precio","precios","cuanto","cuanta","cuestan","cuesta","vale","costo",
    "price","prices","cost","how","much","what","is","que","cual","cuales",
    // planes genéricos (NO industria específica)
    "plan","planes","membresia","membresias",
    "mensual","mensuales",
    "monthly","membership","memberships"
  ]);

  const tokenize = (s: string) =>
    normalize(s)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w && w.length >= 2 && !STOP.has(w));

  const qTokens1 = tokenize(tNormRaw);
  const qTokens2 = tokenize(tAlt);

  // 1) Traer servicios
  const { rows: services } = await pool.query(
    `
    SELECT id, name
    FROM services
    WHERE tenant_id = $1
      AND active = true
      AND name IS NOT NULL
    `,
    [tenantId]
  );

  if (!services?.length) return null;

  const normalized = services.map((s: any) => ({
    id: String(s.id),
    name: String(s.name),
    norm: normalize(s.name),
    tokens: tokenize(s.name),
  }));

  // ----------------------------------------
  // SCORING FUNCTION (MOVIDA ARRIBA)
  // ----------------------------------------

  const tokenFreq = new Map<string, number>();
  for (const s of normalized) {
    const uniq = new Set(s.tokens);
    for (const tok of uniq) {
      tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
    }
  }

  const N = normalized.length;

  const scoreAgainst = (
    qTokens: string[],
    sTokens: string[],
    sNorm: string
  ) => {
    if (!qTokens.length) return 0;

    const sSet = new Set(sTokens);

    let overlapWeighted = 0;
    let qWeightTotal = 0;

    for (const qt of qTokens) {
      const f = tokenFreq.get(qt) || 0;
      const w = 1 / Math.max(1, f);
      qWeightTotal += w;
      if (sSet.has(qt)) overlapWeighted += w;
    }

    const overlap = qWeightTotal > 0 ? overlapWeighted / qWeightTotal : 0;

    let phraseBonus = 0;
    if (qTokens.length >= 2) {
      const qPhrase = qTokens.join(" ");
      if (sNorm.includes(qPhrase)) phraseBonus = 0.25;
    }

    const matchedCount = qTokens.filter((qt) => sSet.has(qt)).length;

    if (matchedCount === 1) {
      const only = qTokens.find((qt) => sSet.has(qt))!;
      const f = tokenFreq.get(only) || 0;
      const frequent = f >= Math.max(2, Math.floor(N * 0.25));
      if (frequent) return overlap * 0.4;
    }

    return overlap + phraseBonus;
  };

  // ----------------------------------------
  // 2) DIRECT MATCH
  // ----------------------------------------

  const hasDirect = (q: string, sNorm: string) => {
    if (!q || !sNorm) return false;
    if (q.length < 4) return false;
    return q.includes(sNorm) || sNorm.includes(q);
  };

  const directCandidates = normalized.filter(
    (s) => hasDirect(tNormRaw, s.norm) || hasDirect(tAlt, s.norm)
  );

  if (directCandidates.length) {
    const scored = directCandidates
      .map((s) => {
        const sc1 = scoreAgainst(qTokens1, s.tokens, s.norm);
        const sc2 = scoreAgainst(qTokens2, s.tokens, s.norm);
        return { s, sc: Math.max(sc1, sc2) };
      })
      .sort((a, b) => b.sc - a.sc);

    const top = scored[0];
    const second = scored[1];

    if (second && Math.abs(top.sc - second.sc) < 0.08) {
      return null;
    }

    return { id: top.s.id, name: top.s.name };
  }

  // ----------------------------------------
  // 3) GENERAL SCORING
  // ----------------------------------------

  const ranked = normalized
    .map((s) => {
      const sc1 = scoreAgainst(qTokens1, s.tokens, s.norm);
      const sc2 = scoreAgainst(qTokens2, s.tokens, s.norm);
      return { s, score: Math.max(sc1, sc2) };
    })
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];

  if (!top || top.score < 0.55) return null;

  if (second && Math.abs(top.score - second.score) < 0.10) {
    return null;
  }

  return { id: top.s.id, name: top.s.name };
}
