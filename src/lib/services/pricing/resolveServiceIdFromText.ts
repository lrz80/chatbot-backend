//src/lib/services/pricing/resolveServiceIdFromText.ts
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

  // Traducción "cross" (ES<->EN) para mejorar match sin hardcode de negocio
  let tAlt = tNormRaw;
  try {
    if (idioma === "es") tAlt = normalize(await traducirMensaje(t, "en"));
    else if (idioma === "en") tAlt = normalize(await traducirMensaje(t, "es"));
  } catch {
    // fallback silencioso
  }

  // Stopwords genéricas (NO por industria) para no sobre-pesar “de / the / price / cuanto”
  const STOP = new Set([
    "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas",
    "para", "por", "en", "y", "o", "a",
    "the", "a", "an", "and", "or", "to", "for", "in", "of",
    "precio", "precios", "cuanto", "cuanta", "cuesta", "vale", "costo",
    "price", "prices", "cost", "how", "much", "what", "is", "que", "cual", "cuales"
  ]);

  const tokenize = (s: string) =>
    normalize(s)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w && w.length >= 2 && !STOP.has(w));

  const qTokens1 = tokenize(tNormRaw);
  const qTokens2 = tokenize(tAlt);

  // 1) Trae servicios del tenant
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

  // 2) Match directo fuerte (frase/substr) con limpieza básica
  //    (ej: "deluxe bath" dentro del nombre)
  const hasDirect = (q: string, sNorm: string) => {
    if (!q || !sNorm) return false;
    // evita que "bano" haga match con todo por ser corto
    if (q.length < 4) return false;
    return q.includes(sNorm) || sNorm.includes(q);
  };

  // Si hay direct match, priorízalo, pero si hay varios, elige el más largo/específico
  const directCandidates = normalized
    .filter((s) => hasDirect(tNormRaw, s.norm) || hasDirect(tAlt, s.norm));

  if (directCandidates.length) {
    // usa el mismo scoring ya existente
    const scored = directCandidates
      .map((s) => {
        const sc1 = scoreAgainst(qTokens1, s.tokens, s.norm);
        const sc2 = scoreAgainst(qTokens2, s.tokens, s.norm);
        return { s, sc: Math.max(sc1, sc2) };
      })
      .sort((a, b) => b.sc - a.sc);

    // si hay empate fuerte (ambiguo), NO adivines
    const top = scored[0];
    const second = scored[1];

    if (second && Math.abs(top.sc - second.sc) < 0.08) {
        return null;
    }

    return { id: top.s.id, name: top.s.name };
    }

  // 3) Scoring robusto: token overlap + bonus por tokens raros (IDF-lite)
  //    Idea: tokens que aparecen en pocos servicios valen más.
  const tokenFreq = new Map<string, number>();
  for (const s of normalized) {
    const uniq = new Set(s.tokens);
    for (const tok of uniq) tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
  }
  const N = normalized.length;

  const scoreAgainst = (qTokens: string[], sTokens: string[], sNorm: string) => {
    if (!qTokens.length) return 0;

    const sSet = new Set(sTokens);

    // (A) overlap ponderado por “rareza”
    let overlapWeighted = 0;
    let qWeightTotal = 0;

    for (const qt of qTokens) {
      const f = tokenFreq.get(qt) || 0;
      // rareza: si aparece en pocos servicios, pesa más
      const w = 1 / Math.max(1, f);
      qWeightTotal += w;
      if (sSet.has(qt)) overlapWeighted += w;
    }

    const overlap = qWeightTotal > 0 ? overlapWeighted / qWeightTotal : 0;

    // (B) bonus si el query tokens aparece “casi como frase”
    //     (no requiere hardcode: solo mira tokens consecutivos)
    let phraseBonus = 0;
    if (qTokens.length >= 2) {
      const qPhrase = qTokens.join(" ");
      if (sNorm.includes(qPhrase)) phraseBonus = 0.25;
    }

    // (C) penaliza matches por token único muy genérico:
    //     si solo coincide 1 token y ese token es frecuente, no debe ganar.
    const matchedCount = qTokens.filter((qt) => sSet.has(qt)).length;
    if (matchedCount === 1) {
      const only = qTokens.find((qt) => sSet.has(qt))!;
      const f = tokenFreq.get(only) || 0;
      const frequent = f >= Math.max(2, Math.floor(N * 0.25)); // aparece en >=25% de servicios
      if (frequent) return overlap * 0.4; // baja el score fuerte
    }

    return overlap + phraseBonus;
  };

  // rank top-2 (no solo best) para detectar ambigüedad real
  const ranked: { s: any; score: number }[] = [];

  for (const s of normalized) {
    const sc1 = scoreAgainst(qTokens1, s.tokens, s.norm);
    const sc2 = scoreAgainst(qTokens2, s.tokens, s.norm);
    const sc = Math.max(sc1, sc2);
    ranked.push({ s, score: sc });
  }

  ranked.sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];

  if (!top || top.score < 0.55) return null;

  // ✅ (1) Empate práctico: si está muy cerca, NO adivines
  if (second && Math.abs(top.score - second.score) < 0.10) {
    return null;
  }

  // ✅ (2) Ambigüedad por “token fuerte”:
  // Si el usuario menciona un token que existe en el 2do candidato
  // pero NO en el top, y ese token es raro en el catálogo → NO adivinar.
  const qTokensAll = Array.from(new Set([...qTokens1, ...qTokens2]));
  const topSet = new Set(top.s.tokens);
  const secondSet = new Set(second?.s.tokens || []);

  const rareToken = (tok: string) => {
    const f = tokenFreq.get(tok) || 0;
    return f > 0 && f <= 2; // aparece en 1–2 servicios → es “fuerte”
  };

  if (second) {
    for (const qt of qTokensAll) {
        if (!topSet.has(qt) && secondSet.has(qt) && rareToken(qt)) {
        return null;
      }
    }
  }

  return { id: top.s.id, name: top.s.name };
}
