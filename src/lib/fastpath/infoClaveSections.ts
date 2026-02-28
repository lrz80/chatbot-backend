// backend/src/lib/fastpath/infoClaveSections.ts
export function extractSectionFromInfoClave(
  infoClave: string,
  sectionTitle: string
): string {
  if (!infoClave) return "";

  const lines = infoClave.split(/\r?\n/);

  const startIdx = lines.findIndex((line) =>
    line.trim().toUpperCase().startsWith(sectionTitle.toUpperCase())
  );
  if (startIdx === -1) return "";

  // Buscar la siguiente línea que parezca otro título en MAYÚSCULAS o termine en ":"
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    const isAllCaps = trimmed === trimmed.toUpperCase();
    const looksLikeTitle = trimmed.endsWith(":") || isAllCaps;
    if (looksLikeTitle) {
      endIdx = i;
      break;
    }
  }

  const section = lines.slice(startIdx, endIdx).join("\n").trim();
  return section;
}

export function extractHorariosFromInfoClave(
  infoClave: string,
  idiomaDestino: "es" | "en"
): string {
  const rawSection = extractSectionFromInfoClave(infoClave, "HORARIOS");
  if (!rawSection) return "";

  const cuerpo = rawSection.replace(/^HORARIOS\s*:?\s*/i, "").trim();

  if (!cuerpo) return "";

  if (idiomaDestino === "en") {
    // si quisieras traducir los labels más adelante, aquí es el sitio
    return `📅 Schedule\n${cuerpo}`;
  }

  return `📅 Horarios\n${cuerpo}`;
}