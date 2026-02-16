import type { Lang } from "../channels/engine/clients/clientDb";
import { extractBinaryChoicePatch } from "./choiceMemory";

export function computeChoiceMemoryPatch(args: {
  assistantText: string;
  lang: Lang;
}): any | null {
  const patch = extractBinaryChoicePatch({
    assistantText: args.assistantText,
    lang: args.lang,
    kind: "interest_selection",
  });

  return patch ? patch : null;
}
