// 🔤 Elimina tildes, pone en minúsculas y remueve espacios innecesarios
export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD') // descompone letras acentuadas
    .replace(/[\u0300-\u036f]/g, '') // elimina los signos diacríticos (tildes)
    .trim();
}
