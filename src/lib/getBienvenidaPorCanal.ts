export function getBienvenidaPorCanal(canal: string, tenant: any, idioma: string = 'es'): string {
  const nombreNegocio = tenant?.name || "tu negocio";

  // Hora local basada en UTC-4 (Eastern Time)
  const date = new Date();
  const horaUTC = date.getUTCHours();
  const hora = (horaUTC - 4 + 24) % 24;

  // Determinar saludo por hora e idioma
  const saludos: Record<string, { dia: string; tarde: string; noche: string }> = {
    es: {
      dia: "Hola, buenos días",
      tarde: "Hola, buenas tardes",
      noche: "Hola, buenas noches",
    },
    en: {
      dia: "Good morning",
      tarde: "Good afternoon",
      noche: "Good evening",
    },
    pt: {
      dia: "Bom dia",
      tarde: "Boa tarde",
      noche: "Boa noite",
    },
    fr: {
      dia: "Bonjour",
      tarde: "Bon après-midi",
      noche: "Bonsoir",
    },
  };

  const saludo = hora >= 5 && hora < 12
    ? saludos[idioma]?.dia || saludos["es"].dia
    : hora >= 12 && hora < 18
    ? saludos[idioma]?.tarde || saludos["es"].tarde
    : saludos[idioma]?.noche || saludos["es"].noche;

  const cuerpo: Record<string, string> = {
    es: `Mi nombre es Amy, asistente de ${nombreNegocio}. ¿En qué puedo ayudarte?`,
    en: `My name is Amy, assistant for ${nombreNegocio}. How can I help you today?`,
    pt: `Meu nome é Amy, assistente de ${nombreNegocio}. Como posso te ajudar?`,
    fr: `Je m'appelle Amy, l'assistante de ${nombreNegocio}. Comment puis-je vous aider ?`,
  };

  return `${saludo}. ${cuerpo[idioma] || cuerpo["es"]}`;
}
