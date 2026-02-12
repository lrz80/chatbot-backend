import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirMensaje } from "../../traducirMensaje";

type Hit = { id: string; name: string };

export type ResolveServiceResult =
  | { kind: "hit"; hit: Hit }
  | { kind: "ambiguous"; options: Hit[] }
  | { kind: "miss" };

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string
): Promise<ResolveServiceResult> {
  let t = String(userText || "").trim();
  if (!t) return { kind: "miss" };

  const idioma = await detectarIdioma(t).catch(() => "es");

  const normalize = (s: string) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const tNormRaw = normalize(t);

  // Traducción ES<->EN para mejorar match (genérico)
  let tAlt = tNormRaw;
  try {
    if (idioma === "es") tAlt = normalize(await traducirMensaje(t, "en"));
    else if (idioma === "en") tAlt = normalize(await traducirMensaje(t, "es"));
  } catch {}

  const STOP = new Set([
    "de","del","la","el","los","las","un","una","unos","unas",
    "para","por","en","y","o","a",
    "the","a","an","and","or","to","for","in","of",
    "precio","precios","cuanto","cuanta","cuesta","vale","costo",
    "price","prices","cost","how","much","what","is","que","cual","cuales"
  ]);

  const tokenize = (s: string) =>
    normalize(s)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w && w.length >= 2 && !STOP.has(w));

  const qTokens1 = tokenize(tNormRaw);
  const qTokens2 = tokenize(tAlt);

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

  if (!services?.length) return { kind: "miss" };

  const normalized = services.map((s: any) => ({
    id: String(s.id),
    name: String(s.name),
    norm: normalize(s.name),
    tokens: tokenize(s.name),
  }));

  // IDF-lite freq
  const tokenFreq = new Map<string, number>();
  for (const s of normalized) {
    const uniq = new Set(s.tokens);
    for (const tok of uniq) tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
  }
  const N = normalized.length;

  // ✅ IMPORTANT: function hoisted (arregla bug de orden)
  function scoreAgainst(qTokens: string[], sTokens: string[], sNorm: string) {
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
  }

  // direct match
  const hasDirect = (q: string, sNorm: string) => {
    if (!q || !sNorm) return false;
    if (q.length < 4) return false;
    return q.includes(sNorm) || sNorm.includes(q);
  };

  const directCandidates = normalized.filter(
    (s) => hasDirect(tNormRaw, s.norm) || hasDirect(tAlt, s.norm)
  );

  const candidates = directCandidates.length ? directCandidates : normalized;

  const scored = candidates
    .map((s) => {
      const sc1 = scoreAgainst(qTokens1, s.tokens, s.norm);
      const sc2 = scoreAgainst(qTokens2, s.tokens, s.norm);
      return { s, score: Math.max(sc1, sc2) };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 0.55) return { kind: "miss" };

  // ✅ empate práctico -> ambiguous con opciones (NO null)
  const TIE_EPS = 0.10;
  const top = scored
    .filter((x) => (best.score - x.score) <= TIE_EPS)
    .slice(0, 5);

  if (top.length >= 2) {
    return {
      kind: "ambiguous",
      options: top.map((x) => ({ id: x.s.id, name: x.s.name })),
    };
  }

  return { kind: "hit", hit: { id: best.s.id, name: best.s.name } };
}
