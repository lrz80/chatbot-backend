//src/lib/voice/realtime/utils/clean.ts
export function clean(value: unknown): string {
  return String(value ?? "").trim();
}