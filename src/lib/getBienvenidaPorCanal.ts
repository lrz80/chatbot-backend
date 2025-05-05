export function getBienvenidaPorCanal(canal: string, tenant: any): string {
    const nombreNegocio = tenant?.name || "tu negocio";
  
    // Usa hora local UTC-4 (ej. Eastern Time)
    const date = new Date();
    const horaUTC = date.getUTCHours();
    const hora = (horaUTC - 4 + 24) % 24; // Ajuste para UTC-4 (Florida)
  
    let saludo = "Hola";
    if (hora >= 5 && hora < 12) saludo = "Hola, buenos días";
    else if (hora >= 12 && hora < 18) saludo = "Hola, buenas tardes";
    else saludo = "Hola, buenas noches";
  
    return `${saludo}. Mi nombre es Amy, asistente de ${nombreNegocio}. ¿En qué puedo ayudarte?`;
  }
  