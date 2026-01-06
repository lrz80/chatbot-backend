import { getMemoryValue, setMemoryValue } from "../clientMemory";

export async function rememberTurn(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  u: string;              // user input
  a: string;              // assistant reply
  maxTurns?: number;      // default 40
}) {
  const { tenantId, canal, senderId, u, a, maxTurns = 40 } = params;

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
