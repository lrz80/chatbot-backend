//src/lib/channels/engine/businessInfo/buildScheduleGroupKey.ts
export function normalizeScheduleGroupText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join("")
    .toLowerCase()
    .trim();
}

export function buildScheduleGroupKey(value: string): string {
  const normalized = normalizeScheduleGroupText(value);
  if (!normalized) return "";

  const out: string[] = [];

  for (const ch of normalized) {
    const isAlphaNum =
      (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");

    if (isAlphaNum) {
      out.push(ch);
    }
  }

  return out.join("");
}