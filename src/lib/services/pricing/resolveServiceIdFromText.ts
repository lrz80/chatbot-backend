import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirMensaje } from "../../traducirMensaje";

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string
): Promise<{ id: string; name: string } | null> {
  let t = String(userText || "").trim();
  if (!t) return null;

  const idioma = await detectarIdioma(t).catch(() => "es");

  // Normalización para acentos y comparación
  const normalize = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const tNorm = normalize(t);

  // 1) Traducción automática (ES → EN o EN → ES) si aplica
  let tTranslated = tNorm;
  try {
    if (idioma === "es") tTranslated = normalize(await traducirMensaje(t, "en"));
    else if (idioma === "en") tTranslated = normalize(await traducirMensaje(t, "es"));
  } catch {
    /* fallback silencioso */
  }

  // 2) Traemos TODOS los servicios del tenant y normalizamos
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

  if (!services.length) return null;

  // Normalizamos cada nombre
  const normalized = services.map((s: any) => ({
    id: s.id,
    name: s.name,
    norm: normalize(s.name),
  }));

  // 3) Intento exacto o substring flexible (t y tTranslated)
  const directMatch =
    normalized.find(s => tNorm.includes(s.norm) || s.norm.includes(tNorm)) ||
    normalized.find(s => tTranslated.includes(s.norm) || s.norm.includes(tTranslated));

  if (directMatch) return { id: directMatch.id, name: directMatch.name };

  // 4) Similaridad difusa (sin depender de pg_trgm)
  function similarity(a: string, b: string) {
    // simple ratio: #caracteres comunes / maxLen
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 0;

    let matches = 0;
    for (const ch of a) if (b.includes(ch)) matches++;

    return matches / maxLen;
  }

  let best: any = null;
  let bestScore = 0;

  for (const s of normalized) {
    const sc1 = similarity(tNorm, s.norm);
    const sc2 = similarity(tTranslated, s.norm);
    const sc = Math.max(sc1, sc2);

    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }

  // umbral flexible 0.35 (funciona para nombres cortos y largos)
  if (best && bestScore >= 0.35) {
    return { id: best.id, name: best.name };
  }

  return null;
}
