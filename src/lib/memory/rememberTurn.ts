import { getMemoryValue, setMemoryValue } from "../clientMemory";

/**
 * Soporta 2 firmas para evitar errores en WhatsApp y otros webhooks:
 *  - Nueva: { u, a, maxTurns }
 *  - Legacy: { userText, assistantText, keepLast }
 */
type RememberTurnParams =
  | {
      tenantId: string;
      canal: string;
      senderId: string;
      u: string;          // user input
      a: string;          // assistant reply
      maxTurns?: number;  // default 40
      // legacy opcionales (por si algún lugar los manda)
      userText?: never;
      assistantText?: never;
      keepLast?: never;
    }
  | {
      tenantId: string;
      canal: string;
      senderId: string;
      userText: string;
      assistantText: string;
      keepLast?: number;  // default 40
      // nuevos opcionales (por si algún lugar los manda)
      u?: never;
      a?: never;
      maxTurns?: never;
    };

export async function rememberTurn(params: RememberTurnParams) {
  const { tenantId, canal, senderId } = params;

  // Normaliza inputs sin romper llamadas viejas
  const u =
    "u" in params ? params.u : params.userText;

  const a =
    "a" in params ? params.a : params.assistantText;

  const maxTurns =
    "maxTurns" in params
      ? (params.maxTurns ?? 40)
      : (params.keepLast ?? 40);

  // 1) carga turns existentes
  const prevTurns = await getMemoryValue<any[]>({
    tenantId,
    canal,
    senderId,
    key: "turns",
  });

  const arr = Array.isArray(prevTurns) ? prevTurns : [];

  // 2) append turno nuevo
  const nextTurns = [
    ...arr,
    {
      u: String(u || "").slice(0, 1500),
      a: String(a || "").slice(0, 1500),
      at: new Date().toISOString(),
    },
  ].slice(-maxTurns);

  // 3) guarda turns
  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "turns",
    value: nextTurns,
  });

  // 4) incrementa summary_meta.turnsSinceRefresh ✅
  const meta = await getMemoryValue<any>({
    tenantId,
    canal,
    senderId,
    key: "summary_meta",
  });

  const prev = meta && typeof meta === "object" ? meta : {};
  const next = Number(prev.turnsSinceRefresh ?? 0) + 1;

  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "summary_meta",
    value: {
      ...prev,
      turnsSinceRefresh: next,
      lastTurnAt: new Date().toISOString(),
    },
  });
}
