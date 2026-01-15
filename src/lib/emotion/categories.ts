export const EMOCIONES_PERMITIDAS = [
  "enfado",
  "frustracion",
  "neutral",
  "interes",
  "entusiasmo",
] as const;

export type Emocion = (typeof EMOCIONES_PERMITIDAS)[number];
