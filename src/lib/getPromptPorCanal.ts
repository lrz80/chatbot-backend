// src/lib/getPromptPorCanal.ts

export function getPromptPorCanal(canal: string, tenant: any, idioma: string = 'es'): string {
  const nombre = tenant.name || "nuestro negocio";
  const funciones = (tenant.funciones_asistente || '').replace(/\\n/g, '\n');
  const info = (tenant.info_clave || '').replace(/\\n/g, '\n');

  if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
    return tenant.prompt_meta || generarPromptPorIdioma(nombre, idioma, funciones, info);
  }

  return tenant.prompt || generarPromptPorIdioma(nombre, idioma, funciones, info);
}

export function getBienvenidaPorCanal(canal: string, tenant: any, idioma: string = 'es'): string {
  const nombre = tenant.name || "nuestro negocio";

  // ✅ WhatsApp / default (columna real que tú tienes)
  const wa = (tenant.mensaje_bienvenida || "").trim();

  // ✅ Meta (puede venir del JOIN o de un objeto meta_config)
  const meta =
    (tenant.bienvenida_meta || "").trim() ||
    (tenant.meta_config?.bienvenida_meta || "").trim();

  // Prioridad por canal
  if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
    return meta || "";
  }

  // Otros canales (WhatsApp, etc.)
  return wa || "";
}

function generarPromptPorIdioma(
  nombre: string,
  idioma: string,
  funciones: string = '',
  info: string = ''
): string {
  funciones = funciones.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  info      = info.replace(/\\n/g, '\n').replace(/\r/g, '').trim();

  // 🔧 Normaliza sin forzar listas (evita que el modelo responda con bullets)
  const normalizarTexto = (txt: string): string => {
    return (txt || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')         // evita saltos excesivos
      .replace(/\. (?=[^\n])/g, '.\n')    // salto después de punto si no hay uno
      .trim();
  };

  funciones = normalizarTexto(funciones);
  info      = normalizarTexto(info);

  const instrucciones: Record<string, string> = {
    es: `Eres Amy, la asistente de IA del negocio ${nombre}. Atiendes clientes como una persona real por WhatsApp, Facebook, Instagram o teléfono.

OBJETIVO:
- Entender qué necesita el cliente.
- Responder usando SOLO la información del negocio.
- Cuando tenga sentido, guiar de forma natural hacia agendar, comprar o avanzar al siguiente paso definido por el negocio.

ESTILO DE RESPUESTA (MUY IMPORTANTE):
- Mensajes CORTOS, tipo WhatsApp (máx. 8–10 líneas, sin párrafos largos).
- Tono cercano y profesional, sin sonar a anuncio ni landing page.
- No repitas la misma presentación en cada mensaje.
- Si algo no está en la información del negocio, dilo y ofrece la mejor alternativa real.

FUNCIONES DEL NEGOCIO (contexto):
${funciones || 'Información general sobre los servicios ofrecidos.'}

INFORMACIÓN DEL NEGOCIO (fuente de verdad para responder):
${info || 'No se proporcionó información adicional.'}

IMPORTANTE:
- No inventes precios, horarios, ubicaciones o promociones.
- Responde siempre en español.`,
    en: `You are Amy, the AI assistant for the business ${nombre}. You speak to customers as a real person would through WhatsApp, Facebook, Instagram or phone.

GOAL:
- Understand what the customer needs.
- Answer using ONLY the business information provided.
- When appropriate, naturally guide them to book, buy, or move to the next step defined by the business.

RESPONSE STYLE (VERY IMPORTANT):
- SHORT WhatsApp-style messages (max 8–10 lines, no long paragraphs).
- Friendly and professional tone, not like an ad or landing page.
- Do NOT repeat the same introduction every time.
- If the information is missing, be honest and offer the closest valid option.

BUSINESS FUNCTIONS (context):
${funciones || 'General information about the services offered.'}

BUSINESS DETAILS (source of truth for answering):
${info || 'No additional info provided.'}

IMPORTANT:
- Do not invent prices, schedules, locations or promotions.
- Always respond in English.`
  };

  const prompt = instrucciones[idioma] || instrucciones['es'];

  console.log("🧠 Prompt generado para idioma:", idioma, " negocio:", nombre);

  return prompt;
}

// Nota: esta función no se usa en este archivo; la dejo intacta por compatibilidad.
function generarBienvenidaPorIdioma(nombre: string, idioma: string): string {
  const mensajes: Record<string, string> = {
    es: `Hola 👋 Soy Amy, bienvenida a ${nombre}. ¿En qué puedo ayudarte hoy?`,
    en: `Hi 👋 I'm Amy, welcome to ${nombre}. How can I help you today?`,
  };

  return mensajes[idioma] || mensajes.es;
}
