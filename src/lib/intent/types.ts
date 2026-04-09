//src/lib/intent/types.ts
export type IntentDefinition = {
  key: string;
  description?: string | null;
  examples?: string[];
  source: "system" | "tenant";
};