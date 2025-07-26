import { traducirTexto } from './traducirTexto';

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

export async function buscarRespuestaDesdeFlowsTraducido(flows: any[], mensajeUsuario: string, idioma: string): Promise<string | null> {
  const normalizado = normalizarTexto(mensajeUsuario);

  for (const flujo of flows) {
    for (const opcion of flujo.opciones || []) {
      const textoTraducido = await traducirTexto(opcion.texto || '', idioma);
      if (normalizarTexto(textoTraducido) === normalizado) {
        return opcion.respuesta || opcion.submenu?.mensaje || null;
      }

      if (opcion.submenu) {
        for (const sub of opcion.submenu.opciones || []) {
          const subTraducido = await traducirTexto(sub.texto || '', idioma);
          if (normalizarTexto(subTraducido) === normalizado) {
            return sub.respuesta || null;
          }
        }
      }
    }
  }

  return null;
}

export async function buscarRespuestaSimilitudFaqsTraducido(faqs: any[], mensaje: string, idioma: string): Promise<string | null> {
  const msg = normalizarTexto(mensaje);

  for (const faq of faqs) {
    const preguntaTraducida = await traducirTexto(faq.pregunta || '', idioma);
    const pregunta = normalizarTexto(preguntaTraducida);
    const palabras = pregunta.split(' ').filter(Boolean);
    const coincidencias = palabras.filter(p => msg.includes(p));
    if (coincidencias.length >= 3) return faq.respuesta;
  }

  return null;
}
