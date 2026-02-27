// backend/src/lib/channels/engine/booking/handleBookingTurn.ts

import { Pool } from "pg";
import type { Canal } from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { runBookingPipeline } from "../../../appointments/booking/bookingPipeline";

type TransitionFn = (params: {
  flow?: string;
  step?: string;
  patchCtx?: any;
}) => void;

// 👇 canal que entiende el booking pipeline
type BookingCanal = "whatsapp" | "facebook" | "instagram";

// 👇 aquí normalizamos lo que venga ("meta", etc.) a un BookingCanal válido
function toBookingCanal(canal: Canal | string): BookingCanal {
  if (canal === "whatsapp") return "whatsapp";
  if (canal === "facebook" || canal === "instagram") return canal;

  // En tu arquitectura usas "meta" para el webhook unificado.
  // A nivel de booking, tratamos "meta" como "facebook" por defecto.
  if (canal === "meta") return "facebook";

  // Fallback defensivo: si llega algo raro, asumimos whatsapp
  return "whatsapp";
}

export type HandleBookingTurnArgs = {
  pool: Pool;
  tenantId: string;
  canal: Canal | string;         // puede venir "whatsapp", "meta", etc.
  contactoNorm: string;
  idiomaDestino: Lang;
  userInput: string;
  messageId: string | null;

  // estado de conversación actual
  ctx: any;

  // flag real de si el tenant tiene booking activo
  bookingEnabled: boolean;

  // prompt base SIN memoria
  promptBase: string;

  // señal de intención detectada / fallback
  detectedIntent: string | null;
  intentFallback: string | null;

  // modo de uso
  mode: "gate" | "guardrail";
  sourceTag: string;

  // helpers que dependen del canal / webhook
  transition: TransitionFn;
  persistState: (nextCtx: any) => Promise<void>;
};

export type HandleBookingTurnResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string | null;
  ctx: any;
};

export async function handleBookingTurn(
  args: HandleBookingTurnArgs
): Promise<HandleBookingTurnResult> {
  const {
    pool,
    tenantId,
    canal,
    contactoNorm,
    idiomaDestino,
    userInput,
    messageId,
    bookingEnabled,
    promptBase,
    detectedIntent,
    intentFallback,
    mode,
    sourceTag,
    transition,
    persistState,
  } = args;

  // Copia local de contexto que podremos actualizar
  let ctxLocal = args.ctx;

  const bookingCanal = toBookingCanal(canal);   // 👈 aquí se resuelve "meta" → "facebook"

  const bk = await runBookingPipeline({
    pool,
    tenantId,
    canal: bookingCanal,          // 👈 ya es "whatsapp" | "facebook" | "instagram"
    contacto: contactoNorm,
    idioma: idiomaDestino,
    userText: userInput,
    messageId,

    ctx: ctxLocal,
    transition,

    bookingEnabled,
    promptBase,

    // si no hay intent explícito, usamos fallback canónico
    detectedIntent: detectedIntent || intentFallback || null,

    mode,
    sourceTag,

    // persistencia + sync de ctx local
    persistState: async (nextCtx: any) => {
      await persistState(nextCtx);
      ctxLocal = nextCtx;
    },
  });

  if (!bk.handled) {
    return {
      handled: false,
      ctx: ctxLocal,
    };
  }

  return {
    handled: true,
    reply: bk.reply,
    source: bk.source,
    intent: bk.intent ?? null,
    ctx: ctxLocal,
  };
}