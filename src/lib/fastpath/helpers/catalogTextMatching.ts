// src/lib/fastpath/helpers/catalogTextMatching.ts
import { normalizeText } from "../../infoclave/resolveIncludes";

function norm(s: any) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function bestNameMatch(
  userText: string,
  items: Array<{ id?: string; name: string; url?: string | null }>
) {
  const u = normalizeText(userText);
  if (!u) return null;

  const hits = items.filter((it) => {
    const n = normalizeText(it.name);
    return n.includes(u) || u.includes(n);
  });

  if (hits.length === 1) return hits[0] as any;
  if (hits.length > 1) {
    return hits.sort(
      (a, b) => normalizeText(b.name).length - normalizeText(a.name).length
    )[0] as any;
  }

  return null;
}

export function extractPlanNamesFromReply(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/);
  const names: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^[•\-\*]/.test(line)) {
      const withoutBullet = line.replace(/^[•\-\*]\s*/, "");
      const idx = withoutBullet.indexOf(":");
      if (idx > 0) {
        const name = withoutBullet.slice(0, idx).trim();
        if (name && !names.includes(name)) {
          names.push(name);
        }
      }
    }
  }

  return names;
}

export function postProcessCatalogReply(params: {
  reply: string;
  questionType:
    | "combination_and_price"
    | "price_or_plan"
    | "schedule_and_price"
    | "other_plans";
  prevNames: string[];
}) {
  const { reply, questionType, prevNames } = params;

  if (!prevNames.length) {
    return {
      finalReply: reply,
      namesShown: extractPlanNamesFromReply(reply),
    };
  }

  const prevSet = new Set(prevNames.map((n) => norm(n)));

  const lines = String(reply || "").split(/\r?\n/);
  const filteredLines: string[] = [];
  const bulletRegex = /^[•\-\*]\s*/;
  const keptNames: string[] = [];

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    if (!trimmed || !bulletRegex.test(trimmed)) {
      filteredLines.push(line);
      continue;
    }

    const withoutBullet = trimmed.replace(bulletRegex, "");
    const colonIdx = withoutBullet.indexOf(":");

    if (colonIdx <= 0) {
      filteredLines.push(line);
      continue;
    }

    const name = withoutBullet.slice(0, colonIdx).trim();
    const nameNorm = norm(name);

    if (questionType === "other_plans" && prevSet.has(nameNorm)) {
      continue;
    }

    filteredLines.push(line);
    keptNames.push(name);
  }

  if (!keptNames.length) {
    return {
      finalReply: reply,
      namesShown: extractPlanNamesFromReply(reply),
    };
  }

  return {
    finalReply: filteredLines.join("\n"),
    namesShown: keptNames,
  };
}

export function extractBulletLines(text: string): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("•") || line.startsWith("-"));
}

export function sameBulletStructure(a: string, b: string): boolean {
  const aBullets = extractBulletLines(a);
  const bBullets = extractBulletLines(b);

  if (aBullets.length !== bBullets.length) return false;

  for (let i = 0; i < aBullets.length; i++) {
    if (aBullets[i] !== bBullets[i]) return false;
  }

  return true;
}