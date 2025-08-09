import stringSimilarity from "string-similarity";

export function buscarRespuestaDesdeFlows(flows: any[], mensajeUsuario: string): string | null {
  if (!Array.isArray(flows)) return null; // 🛡️ Protección contra null, undefined o tipo incorrecto

  const normalizarTexto = (texto: string): string =>
    texto
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

  const normalizadoUsuario = normalizarTexto(mensajeUsuario);
  const UMBRAL_SIMILITUD = 0.7; // 70% de coincidencia mínima

  for (const flujo of flows) {
    for (const opcion of flujo.opciones || []) {
      const textoOpcion = normalizarTexto(opcion.texto || '');

      // 🔍 Coincidencia por similitud para opción principal
      if (
        opcion.respuesta &&
        stringSimilarity.compareTwoStrings(textoOpcion, normalizadoUsuario) >= UMBRAL_SIMILITUD
      ) {
        return opcion.respuesta;
      }

      // 🔍 Coincidencia por similitud para submenú
      if (opcion.submenu) {
        for (const sub of opcion.submenu.opciones || []) {
          const textoSub = normalizarTexto(sub.texto || '');
          if (
            sub.respuesta &&
            stringSimilarity.compareTwoStrings(textoSub, normalizadoUsuario) >= UMBRAL_SIMILITUD
          ) {
            return sub.respuesta;
          }
        }
      }
    }
  }

  return null;
}
