// backend/src/lib/parseDatosCliente.ts

export type ParsedCliente = {
  nombre?: string | null;
  email?: string | null;
  telefono?: string | null;
  raw?: string | null;
};

/**
 * Parser GENÉRICO de datos del cliente a partir del texto del mensaje.
 * - No tiene lógica específica por negocio (multi-tenant safe).
 * - Extrae email y teléfono si aparecen en el texto.
 * - Devuelve también el texto original en `raw` por si otro módulo lo quiere usar.
 */
export async function parseDatosCliente(args: {
  tenantId: string;
  canal: string;
  userInput: string;
  idiomaDestino: string;
}): Promise<ParsedCliente> {
  const { userInput } = args;
  const text = (userInput || "").trim();

  // Email muy básico
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  // Teléfono básico: 9–15 dígitos (con posible "+")
  const phoneMatch = text
    .replace(/[^\d+]/g, " ")
    .match(/(\+?\d{9,15})/);

  return {
    nombre: null, // lo puedes enriquecer luego si algún día detectas nombres
    email: emailMatch ? emailMatch[0] : null,
    telefono: phoneMatch ? phoneMatch[1] : null,
    raw: text || null,
  };
}