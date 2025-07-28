import { traducirTexto } from './traducirTexto';
import stringSimilarity from 'string-similarity';

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

export async function buscarRespuestaDesdeFlowsTraducido(
  flows: any[],
  mensajeUsuario: string,
  idioma: string
): Promise<string | null> {
  const normalizado = normalizarTexto(mensajeUsuario);

  for (const flujo of flows) {
    for (const opcion of flujo.opciones || []) {
      const textoTraducido = await traducirTexto(opcion.texto || '', idioma);
      const similitud = stringSimilarity.compareTwoStrings(
        normalizado,
        normalizarTexto(textoTraducido)
      );
      if (similitud > 0.85) {
        return opcion.respuesta || opcion.submenu?.mensaje || null;
      }

      if (opcion.submenu) {
        for (const sub of opcion.submenu.opciones || []) {
          const subTraducido = await traducirTexto(sub.texto || '', idioma);
          const subSimilitud = stringSimilarity.compareTwoStrings(
            normalizado,
            normalizarTexto(subTraducido)
          );
          if (subSimilitud > 0.85) {
            return sub.respuesta || null;
          }
        }
      }
    }
  }

  return null;
}

export async function buscarRespuestaSimilitudFaqsTraducido(
  faqs: any[],
  mensaje: string,
  idioma: string
): Promise<string | null> {
  const normalizado = normalizarTexto(mensaje);

  for (const faq of faqs) {
    const preguntaTraducida = await traducirTexto(faq.pregunta || '', idioma);
    const preguntaNormalizada = normalizarTexto(preguntaTraducida);
    const similitud = stringSimilarity.compareTwoStrings(normalizado, preguntaNormalizada);
    if (similitud > 0.85) return faq.respuesta;
  }

  return null;
}
