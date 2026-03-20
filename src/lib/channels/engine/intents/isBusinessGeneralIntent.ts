import type { Canal } from "../../../detectarIntencion";

type Args = {
  detectedIntent?: string | null;
  intentFallback?: string | null;
  canal?: Canal | string | null;
};

export function isBusinessGeneralIntent(args: Args): boolean {
  const intent = String(
    args.detectedIntent || args.intentFallback || ""
  )
    .trim()
    .toLowerCase();

  if (!intent) return false;

  return (
    intent === "ubicacion" ||
    intent === "horarios" ||
    intent === "info_general" ||
    intent === "info_horarios_generales" ||
    intent === "contacto"
  );
}