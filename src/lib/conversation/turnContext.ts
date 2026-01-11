// backend/src/lib/conversation/turnContext.ts
import type { Pool } from "pg";
import type { Canal } from "../detectarIntencion";

export type Idioma = "es" | "en";

export type TurnContext = {
  // Infra
  pool: Pool;

  // Identidad del turno
  tenantId: string;
  canal: Canal;            // "whatsapp" | "facebook" | "instagram" | etc (tu union real)
  contacto: string;        // contactoKey / senderId normalizado
  userInput: string;
  messageId: string | null;

  // Idioma + prompts
  idiomaDestino: Idioma;
  promptBase: string;

  // Estado conversacional (si lo usas en gates)
  stateTable?: string;     // opcional si algunos gates lo usan
  ctxColumn?: string;      // opcional

  // Utilidades que gates puedan necesitar (sin hardcode)
  parseDatosCliente: (text: string) => { nombre: string; email: string; telefono: string; pais: string } | null;
  extractPaymentLinkFromPrompt: (promptBase: string) => string | null;

  // Regex/config que gates usan
  PAGO_CONFIRM_REGEX: RegExp;
};
