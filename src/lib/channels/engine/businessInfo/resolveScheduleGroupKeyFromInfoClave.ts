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
  userInput: string;
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

function buildResolutionText(groupLabel: string, userInput: string): string {
  const left = String(groupLabel || "").trim();
  const right = String(userInput || "").trim();

  if (!left && !right) {
    return "";
  }

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return `${left}\n${right}`;
}

function extractAnchoredServiceId(resolved: unknown): string | null {
  if (!resolved || typeof resolved !== "object") {
    return null;
  }

  const data = resolved as {
    kind?: string;
    hit?: { id?: string | null } | null;
    serviceId?: string | null;
  };

  const kind = String(data.kind || "").trim().toLowerCase();

  if (kind === "resolved_single") {
    const id = String(data.hit?.id || "").trim();
    return id || null;
  }

  if (kind === "ambiguous") {
    const id = String(data.serviceId || "").trim();
    return id || null;
  }

  return null;
}

export async function resolveScheduleGroupKeyFromInfoClave(
  args: ResolveScheduleGroupKeyFromInfoClaveArgs
): Promise<string | null> {
  const serviceId = String(args.serviceId || "").trim();
  const userInput = String(args.userInput || "").trim();
  const infoClave = String(args.infoClave || "").trim();

  if (!serviceId || !userInput || !infoClave) {
    return null;
  }

  const groups = extractScheduleGroups(infoClave);

  if (groups.length === 0) {
    return null;
  }

  const matches: Array<{ scheduleGroupKey: string }> = [];

  for (const group of groups) {
    const resolutionText = buildResolutionText(group.groupLabel, userInput);
    if (!resolutionText) {
      continue;
    }

    const resolved = await resolveServiceCandidatesFromText(
      args.pool,
      args.tenantId,
      resolutionText,
      { mode: "loose" }
    );

    const anchoredServiceId = extractAnchoredServiceId(resolved);
    if (!anchoredServiceId) {
      continue;
    }

    if (anchoredServiceId !== serviceId) {
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