// backend/src/lib/services/fastpath/gates/generalAsks.ts

export function wantsGeneralPrices(text: string) {
  const t = String(text || "").toLowerCase().trim();

  const asksPrice =
    /\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|tarifa|cost(o|os))\b/.test(t) ||
    /\b(price|prices|how\s+much|how\s+much\s+is|cost|rate|fee)\b/.test(t);

  if (!asksPrice) return false;

  // quitamos tokens de "precio" y dejamos lo demás
  let remainder = t
    .replace(/\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|tarifa|cost(o|os))\b/g, "")
    .replace(/\b(price|prices|how\s+much|how\s+much\s+is|cost|rate|fee)\b/g, "")
    .replace(/[^a-z0-9áéíóúñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // ✅ quita “relleno” típico: "cuales son los", "dime", "me puedes", etc.
  remainder = remainder
    .replace(/\b(cuales|cu[aá]les|son|los|las|el|la|de|del|para|por|me|puedes|podr[ií]as|dime|quiero|necesito|info|informaci[oó]n)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Si después de quitar relleno NO queda nada, es general.
  if (remainder.length === 0) return true;

  // Si queda muy poco, también es general.
  return remainder.length <= 10;
}

export function wantsMoreInfoOnly(text: string) {
  const t = String(text || "").toLowerCase().trim();

  const asksMore =
    /\b(m[aá]s\s*info(rmaci[oó]n)?|quiero\s+m[aá]s\s+info|dame\s+m[aá]s\s+info|m[aá]s\s+detalles|detalles)\b/.test(t) ||
    /\b(more\s+info(rmation)?|more\s+details|details|tell\s+me\s+more)\b/.test(t);

  if (!asksMore) return false;

  const specific =
    /\b(precio|precios|cu[aá]nto|price|prices|cost|rate|fee)\b/.test(t) ||
    /\b(horario|horarios|hours|open|close|ubicaci[oó]n|location|address)\b/.test(t) ||
    /\b(reserv|cita|booking|appointment|schedule)\b/.test(t) ||
    /\b(servicios|services|lista|menu|cat[aá]logo|catalog)\b/.test(t);

  return !specific;
}
