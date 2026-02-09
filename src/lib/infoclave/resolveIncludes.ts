// backend/src/lib/infoclave/resolveIncludes.ts

export function normalizeText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAskingIncludes(text: string): boolean {
  const s = normalizeText(text);
  return (
    /\b(que incluye|q incluye|incluye|incluido|includes|what does.*include|what.*included)\b/.test(s)
  );
}

// Detecta si la línea parece un item del catálogo (precio, guion, etc.)
function isCatalogLine(l: string): boolean {
  return /(\$|\busd\b|—|:)/i.test(l);
}

// Busca bloque correspondiente al servicio en info_clave
export function findServiceBlock(infoClave: string, userText: string) {
  const lines = String(infoClave || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const q = normalizeText(userText);

  const scoreLine = (line: string) => {
    if (!isCatalogLine(line)) return 0;
    const ln = normalizeText(line);
    const tokens = q.split(" ").filter((w) => w.length >= 4); // tokens fuertes
    let hits = 0;
    for (const w of tokens) if (ln.includes(w)) hits++;
    return hits;
  };

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const sc = scoreLine(lines[i]);
    if (sc > bestScore) {
      bestScore = sc;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < 2) return null; // umbral mínimo de match

  // Toma la línea del servicio + siguientes (donde suele estar Incluye:)
  const block = [lines[bestIdx]];
  for (let k = 1; k <= 4; k++) {
    const next = lines[bestIdx + k];
    if (!next) break;

    if (k > 1 && isCatalogLine(next) && !/^incluye[:\s]/i.test(next)) break;

    block.push(next);
  }

  return {
    title: block[0],
    lines: block,
  };
}

export function extractIncludesLine(blockLines: string[]) {
  const hitEs = blockLines.find((l) => /^incluye\s*:/i.test(l));
  if (hitEs) return hitEs.replace(/^incluye\s*:\s*/i, "").trim();

  const hitEn = blockLines.find((l) => /^includes\s*:/i.test(l));
  if (hitEn) return hitEn.replace(/^includes\s*:\s*/i, "").trim();

  return null;
}
