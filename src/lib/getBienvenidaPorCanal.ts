export function getBienvenidaPorCanal(canal: string, tenant: any): string {
  const nombreNegocio = tenant?.name || "tu negocio";

  const hora = new Date().getHours();
  let saludo = "Hola";
  if (hora >= 5 && hora < 12) saludo = "Hola, buenos días";
  else if (hora >= 12 && hora < 18) saludo = "Hola, buenas tardes";
  else saludo = "Hola, buenas noches";

  return `${saludo}. Mi nombre es Amy, asistente de ${nombreNegocio}. ¿En qué puedo ayudarte?`;
}
