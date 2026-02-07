// backend/src/lib/services/fastpath/ui/servicePickUi.ts
type Lang = "es" | "en";

function looksLikeVariants(labels: string[]) {
  const prefixes = labels
    .map((l) => String(l || "").split(" - ")[0].trim())
    .filter(Boolean);

  if (!prefixes.length) return false;

  const freq = new Map<string, number>();
  for (const p of prefixes) freq.set(p, (freq.get(p) || 0) + 1);
  const top = Math.max(...Array.from(freq.values()));
  return top >= 2;
}

function humanNeedLabel(need: string, lang: Lang) {
  const n = String(need || "any");
  if (lang === "en") {
    if (n === "price") return "the price";
    if (n === "duration") return "the duration";
    if (n === "includes") return "what it includes";
    return "more details";
  }
  if (n === "price") return "el precio";
  if (n === "duration") return "la duración";
  if (n === "includes") return "qué incluye";
  return "más detalles";
}

export function renderPickMenu(options: any[], need: string, lang: Lang) {
  const labels = options.map((o) => String(o.label || ""));
  const isVar = looksLikeVariants(labels);

  const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
  const what = humanNeedLabel(need, lang);

  if (lang === "en") {
    return (
      `${isVar ? "Which option do you want?" : "Which service do you mean?"} ` +
      `Reply with the number so I can give you ${what}:\n\n` +
      `${lines}\n\n` +
      `Reply with just the number (e.g. 1).`
    );
  }

  return (
    `${isVar ? "¿Cuál opción quieres?" : "¿A cuál servicio te refieres?"} ` +
    `Respóndeme con el número para darte ${what}:\n\n` +
    `${lines}\n\n` +
    `Solo responde con el número (ej: 1).`
  );
}

export function renderOutOfRangeMenu(options: any[], lang: Lang) {
  const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
  if (lang === "en") return `That number isn’t in the list. Please choose one of these:\n\n${lines}`;
  return `Ese número no está en la lista. Elige una de estas opciones:\n\n${lines}`;
}

export function renderExpiredPick(lang: Lang) {
  if (lang === "en") {
    return "That selection expired (it was pending for a while). Ask again about the service and I’ll show the options again.";
  }
  return "Esa selección expiró (quedó pendiente por un rato). Vuelve a preguntarme por el servicio y te muestro las opciones otra vez.";
}

export function shortenUrl(u?: string | null) {
  if (!u) return "";
  try {
    const url = new URL(u);
    const path = url.pathname.length > 28 ? url.pathname.slice(0, 28) + "…" : url.pathname;
    return `${url.host}${path}`;
  } catch {
    const s = String(u);
    return s.slice(0, 40) + (s.length > 40 ? "…" : "");
  }
}

export function looksLikeVariantsOfSameService(labels: string[]) {
  const prefixes = labels
    .map((l) => String(l || ""))
    .map((l) => l.split(" - ")[0].trim())
    .filter(Boolean);

  if (!prefixes.length) return false;

  const freq = new Map<string, number>();
  for (const p of prefixes) freq.set(p, (freq.get(p) || 0) + 1);

  const top = Array.from(freq.values()).sort((a, b) => b - a)[0] || 0;
  return top >= 2;
}
