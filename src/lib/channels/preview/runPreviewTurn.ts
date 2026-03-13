import type { Pool } from "pg";

type CanalPreview = "whatsapp" | "meta";

type PreviewHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

type RunPreviewTurnArgs = {
  pool: Pool;
  tenant: any;
  canal: CanalPreview;
  userInput: string;
  history?: PreviewHistoryItem[];
  previewContactId: string;
};

type RunPreviewTurnResult = {
  response: any;
  kind?: string;
  detectedLang?: string | null;
};

export async function runPreviewTurn({
  pool,
  tenant,
  canal,
  userInput,
  history = [],
  previewContactId,
}: RunPreviewTurnArgs): Promise<RunPreviewTurnResult> {
  /**
   * ✅ ESTE ARCHIVO NO DEBE TENER LÓGICA NUEVA DE BOT.
   * Debe ser solamente un ADAPTADOR al engine real.
   *
   * La idea es:
   * - usar el mismo entrypoint que usan tus webhooks
   * - pero con side-effects desactivados
   */

  // =========================================================
  // PASO 1: construir contexto sintético de preview
  // =========================================================
  const convoCtx = {
    preview: true,
    history,
    contacto: previewContactId,
  };

  // =========================================================
  // PASO 2: llamar el engine real
  // =========================================================
  /**
   * ⛳ AQUÍ debes reutilizar TU entrypoint real del canal.
   *
   * Ejemplos conceptuales:
   *
   * const result = await runChannelEngineTurn({...})
   * const result = await handleEngineTurn({...})
   * const result = await processInboundTurn({...})
   *
   * Debe ser el MISMO que usan:
   * - WhatsApp webhook
   * - Facebook/Instagram webhook
   *
   * pero pasando flags:
   * - preview: true
   * - persist: false
   * - writeDb: false
   * - incrementUsage: false
   * - sendOutbound: false
   * - scheduleFollowups: false
   */

  // 🔴 TEMPORAL: lanza error hasta conectar el engine real.
  // Reemplaza este bloque por tu llamada real.
  throw new Error(
    "runPreviewTurn aún no está conectado al engine real. Conéctalo al mismo entrypoint que usan tus webhooks."
  );

  /**
   * ✅ Ejemplo de forma esperada del return:
   *
   * return {
   *   response: result.reply,
   *   kind: result.kind ?? "engine",
   *   detectedLang: result.lang ?? null,
   * };
   */
}