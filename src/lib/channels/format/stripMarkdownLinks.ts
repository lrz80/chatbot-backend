export function stripMarkdownLinksForDm(text: string): string {
  const input = String(text || "");

  return input.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    const cleanLabel = String(label || "").trim();
    const cleanUrl = String(url || "").trim();

    // Si el "texto" del link ya es el mismo URL, dejamos solo el URL una sola vez
    if (cleanLabel === cleanUrl) {
      return cleanUrl;
    }

    // Si el texto era algo amigable, lo dejamos como "Texto: URL"
    return `${cleanLabel}: ${cleanUrl}`;
  });
}