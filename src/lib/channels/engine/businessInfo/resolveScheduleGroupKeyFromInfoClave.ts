//src/lib/channels/engine/businessInfo/resolveScheduleGroupKeyFromInfoClave.ts
import type { Pool } from "pg";
import { extractStructuredSchedules } from "../../../fastpath/helpers/extractSchedulesOnly";
import { resolveServiceCandidatesFromText } from "../../../services/pricing/resolveServiceIdFromText";
import { buildScheduleGroupKey } from "./buildScheduleGroupKey";

type ResolveScheduleGroupKeyFromInfoClaveArgs = {
  pool: Pool;
  tenantId: string;
  infoClave: string;
  serviceId: string;
};

type StructuredScheduleEntry = {
  rawLine?: string | null;
};

function trimBulletPrefix(value: string): string {
  let out = String(value || "").trimStart();

  while (out.length > 0) {
    const first = out[0];
    if (
      first === "•" ||
      first === "*" ||
      first === "-" ||
      first === "–" ||
      first === "—"
    ) {
      out = out.slice(1).trimStart();
      continue;
    }
    break;
  }

  return out.trim();
}

function findFirstSeparatorIndex(value: string): number {
  const separators = [" – ", " — ", " - ", ": "];

  let best = -1;

  for (const separator of separators) {
    const idx = value.indexOf(separator);
    if (idx === -1) continue;
    if (best === -1 || idx < best) {
      best = idx;
    }
  }

  return best;
}

function extractGroupLabelFromRawLine(rawLine: string): string | null {
  const cleaned = trimBulletPrefix(String(rawLine || "").trim());

  if (!cleaned) {
    return null;
  }

  const separatorIndex = findFirstSeparatorIndex(cleaned);
  if (separatorIndex <= 0) {
    return null;
  }

  const label = cleaned.slice(0, separatorIndex).trim();
  return label || null;
}

function extractScheduleGroups(infoClave: string): Array<{
  groupLabel: string;
  scheduleGroupKey: string;
}> {
  const entries = extractStructuredSchedules(infoClave) as StructuredScheduleEntry[];

  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const groups: Array<{ groupLabel: string; scheduleGroupKey: string }> = [];

  for (const entry of entries) {
    const rawLine = String(entry?.rawLine || "").trim();
    if (!rawLine) continue;

    const groupLabel = extractGroupLabelFromRawLine(rawLine);
    if (!groupLabel) continue;

    const scheduleGroupKey = buildScheduleGroupKey(groupLabel);
    if (!scheduleGroupKey || seen.has(scheduleGroupKey)) continue;

    seen.add(scheduleGroupKey);
    groups.push({ groupLabel, scheduleGroupKey });
  }

  return groups;
}

export async function resolveScheduleGroupKeyFromInfoClave(
  args: ResolveScheduleGroupKeyFromInfoClaveArgs
): Promise<string | null> {
  const serviceId = String(args.serviceId || "").trim();
  const infoClave = String(args.infoClave || "").trim();

  if (!serviceId || !infoClave) {
    return null;
  }

  const groups = extractScheduleGroups(infoClave);

  if (groups.length === 0) {
    return null;
  }

  const matches: Array<{ scheduleGroupKey: string }> = [];

  for (const group of groups) {
    const resolved = await resolveServiceCandidatesFromText(
      args.pool,
      args.tenantId,
      group.groupLabel,
      { mode: "loose" }
    );

    if (resolved.kind !== "resolved_single" || !resolved.hit) {
      continue;
    }

    if (String(resolved.hit.id).trim() !== serviceId) {
      continue;
    }

    matches.push({
      scheduleGroupKey: group.scheduleGroupKey,
    });
  }

  if (matches.length !== 1) {
    return null;
  }

  return matches[0].scheduleGroupKey;
}