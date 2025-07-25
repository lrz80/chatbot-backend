import stringSimilarity from 'string-similarity';

/**
 * 🔤 Normaliza preguntas y respuestas para comparación.
 */
export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // elimina acentos
    .replace(/[¿¡?.,]/g, '')         // elimina signos
    .replace(/\s+/g, ' ')            // espacios duplicados
    .trim();
}

/**
 * 🧹 Limpia respuestas de frases genéricas y nombres de marca.
 */
export function limpiarRespuesta(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // elimina acentos
    .replace(/[^\w\s\n]/g, '')       // signos, pero conserva saltos de línea
    .replace(/[ \t]+/g, ' ')         // reemplaza múltiples espacios/tabs, pero no \n
    .replace(
      /\b(hola|claro|esperamos verte pronto|espero que te sea útil|puedo ayudarte|te puedo ayudar|no dudes en preguntar|spinzone indoor cycling|aamy ai)\b/gi,
      ''
    )
    .trim();
}

/**
 * ✅ Retorna la FAQ sugerida si ya existe.
 */
export function yaExisteComoFaqSugerida(
    pregunta: string,
    respuesta: string,
    faqsSugeridas: { id: number; pregunta: string; respuesta_sugerida: string | null }[]
  ): { id: number; pregunta: string; respuesta_sugerida: string | null } | undefined {
    const preguntaNorm = normalizarTexto(pregunta);
    const respuestaNorm = limpiarRespuesta(respuesta);
  
    return faqsSugeridas.find(faq => {
      const preguntaFaq = normalizarTexto(faq.pregunta);
      const respuestaFaq = limpiarRespuesta(faq.respuesta_sugerida || '');
  
      const similitudPregunta = stringSimilarity.compareTwoStrings(
        preguntaFaq,
        preguntaNorm
      );
      const similitudRespuesta = stringSimilarity.compareTwoStrings(
        respuestaFaq,
        respuestaNorm
      );
  
      return (
        similitudPregunta > 0.75 ||
        similitudRespuesta > 0.92 ||
        preguntaFaq.includes(preguntaNorm)
      );
    });
  }
  
  /**
   * ✅ Retorna la FAQ aprobada si ya existe.
   */
  export function yaExisteComoFaqAprobada(
    pregunta: string,
    respuesta: string,
    faqsAprobadas: { id?: number; pregunta: string; respuesta: string }[]
  ): { id?: number; pregunta: string; respuesta: string } | undefined {
    const preguntaNorm = normalizarTexto(pregunta);
    const respuestaNorm = limpiarRespuesta(respuesta);
  
    return faqsAprobadas.find(faq => {
      const preguntaFaq = normalizarTexto(faq.pregunta);
      const respuestaFaq = limpiarRespuesta(faq.respuesta);
  
      const similitudPregunta = stringSimilarity.compareTwoStrings(
        preguntaFaq,
        preguntaNorm
      );
      const similitudRespuesta = stringSimilarity.compareTwoStrings(
        respuestaFaq,
        respuestaNorm
      );
  
      return (
        similitudPregunta > 0.75 ||
        similitudRespuesta > 0.92 ||
        preguntaFaq.includes(preguntaNorm)
      );
    });
  }
  