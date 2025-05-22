export function buscarRespuestaDesdeFlows(flows: any[], mensajeUsuario: string): string | null {
  if (!Array.isArray(flows)) return null; // 🛡️ Protección contra null, undefined o tipo incorrecto

  const normalizarTexto = (texto: string): string =>
    texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  const normalizado = normalizarTexto(mensajeUsuario);

  for (const flujo of flows) {
    for (const opcion of flujo.opciones || []) {
      if (normalizarTexto(opcion.texto || '') === normalizado && opcion.respuesta) {
        return opcion.respuesta;
      }
      if (opcion.submenu) {
        for (const sub of opcion.submenu.opciones || []) {
          if (normalizarTexto(sub.texto || '') === normalizado && sub.respuesta) {
            return sub.respuesta;
          }
        }
      }
    }
  }

  return null;
}
