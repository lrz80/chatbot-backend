"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPromptPorCanal = getPromptPorCanal;
exports.getBienvenidaPorCanal = getBienvenidaPorCanal;
function getPromptPorCanal(canal, tenant, idioma = 'es') {
    const nombre = tenant.name || "nuestro negocio";
    const funciones = tenant.funciones_asistente || '';
    const info = tenant.info_clave || '';
    if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
        return tenant.prompt_meta || generarPromptPorIdioma(nombre, idioma, funciones, info);
    }
    return tenant.prompt || generarPromptPorIdioma(nombre, idioma, funciones, info);
}
function getBienvenidaPorCanal(canal, tenant, idioma = 'es') {
    const nombre = tenant.name || "nuestro negocio";
    if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
        return generarBienvenidaPorIdioma(nombre, idioma);
    }
    return generarBienvenidaPorIdioma(nombre, idioma);
}
function generarPromptPorIdioma(nombre, idioma, funciones = '', info = '') {
    const instrucciones = {
        es: `Eres Amy, la asistente AI de ${nombre}. Tu tarea es ayudar a los clientes con lo siguiente:\n\n${funciones || 'Información general sobre los servicios ofrecidos.'}\n\nInformación clave del negocio:\n${info || 'No se proporcionó información adicional.'}\n\nResponde siempre de forma clara, útil y amigable, en español.`,
        en: `You are Amy, the AI assistant for ${nombre}. Your task is to help customers with:\n\n${funciones || 'General information about the services offered.'}\n\nKey business info:\n${info || 'No additional info provided.'}\n\nAlways reply clearly, helpfully, and in English.`,
        pt: `Você é Amy, a assistente de IA de ${nombre}. Sua tarefa é ajudar os clientes com:\n\n${funciones || 'Informações gerais sobre os serviços oferecidos.'}\n\nInformações chave do negócio:\n${info || 'Nenhuma informação adicional fornecida.'}\n\nSempre responda de forma clara, útil e amigável, em português.`,
        fr: `Vous êtes Amy, l'assistante IA de ${nombre}. Votre tâche est d'aider les clients avec :\n\n${funciones || 'Informations générales sur les services offerts.'}\n\nInformations clés de l'entreprise :\n${info || 'Aucune information supplémentaire fournie.'}\n\nRépondez toujours de manière claire, utile et sympathique, en français.`,
    };
    return instrucciones[idioma] || instrucciones['es'];
}
function generarBienvenidaPorIdioma(nombre, idioma) {
    const mensajes = {
        es: `Hola 👋 Soy Amy, bienvenido a ${nombre}. ¿En qué puedo ayudarte hoy?`,
        en: `Hi 👋 I'm Amy, welcome to ${nombre}. How can I help you today?`,
        pt: `Olá 👋 Sou Amy, bem-vindo ao ${nombre}. Como posso te ajudar hoje?`,
        fr: `Bonjour 👋 Je suis Amy, bienvenue à ${nombre}. Comment puis-je vous aider ?`,
    };
    return mensajes[idioma] || mensajes.es;
}
