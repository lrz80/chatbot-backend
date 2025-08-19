export function normalizeSynonyms(input: string): string {
  let s = input || '';
  // canónico: "online"
  s = s.replace(/\ben\s*l[ií]nea\b/gi, 'online');
  s = s.replace(/\bvirtual(?:es|idad)?\b/gi, 'online');
  // puedes añadir más sinónimos globales aquí si quieres
  return s;
}
