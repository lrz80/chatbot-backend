export function getPromptPorCanal(canal: string, tenant: any, idioma: string = 'es'): string {
  const nombre = tenant.name || "nuestro negocio";

  // Si el tenant ya tiene un prompt personalizado Y el idioma coincide, úsalo
  if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
    return tenant.prompt_meta || generarPromptPorIdioma(nombre, idioma);
  }

  // Si el idioma del cliente no coincide con el idioma del prompt guardado, generamos uno nuevo
  return generarPromptPorIdioma(nombre, idioma);
}

export function getBienvenidaPorCanal(canal: string, tenant: any, idioma: string = 'es'): string {
  const nombre = tenant.name || "nuestro negocio";

  if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
    return generarBienvenidaPorIdioma(nombre, idioma);
  }

  return generarBienvenidaPorIdioma(nombre, idioma);
}

function generarPromptPorIdioma(nombre: string, idioma: string): string {
  const prompts: Record<string, string> = {
    es: `Eres Amy, una asistente AI amigable de ${nombre}. Responde en español de forma clara y útil.`,
    en: `You are Amy, a friendly AI assistant for ${nombre}. Reply in English clearly and helpfully.`,
    pt: `Você é a Amy, uma assistente de IA simpática do ${nombre}. Responda em português de forma clara e útil.`,
    fr: `Vous êtes Amy, une assistante IA sympathique de ${nombre}. Répondez en français clairement et utilement.`,
  };

  return prompts[idioma] || prompts.es;
}

function generarBienvenidaPorIdioma(nombre: string, idioma: string): string {
  const mensajes: Record<string, string> = {
    es: `Hola 👋 Soy Amy, bienvenido a ${nombre}. ¿En qué puedo ayudarte hoy?`,
    en: `Hi 👋 I'm Amy, welcome to ${nombre}. How can I help you today?`,
    pt: `Olá 👋 Sou Amy, bem-vindo ao ${nombre}. Como posso te ajudar hoje?`,
    fr: `Bonjour 👋 Je suis Amy, bienvenue à ${nombre}. Comment puis-je vous aider ?`,
  };

  return mensajes[idioma] || mensajes.es;
}
