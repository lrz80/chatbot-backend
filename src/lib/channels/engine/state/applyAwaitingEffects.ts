// backend/src/lib/channels/engine/state/applyAwaitingEffects.ts
import { clearAwaitingState } from "../../../awaiting";

/**
 * Aplica efectos declarativos del state machine (awaiting).
 * OJO: No conoce nada del negocio. Solo mapea fields -> upserts.
 */
export async function applyAwaitingEffects(opts: {
  tenantId: string;
  canal: any;      // Canal (whatsapp/facebook/instagram) o string
  contacto: string;
  effects?: any;

  // Inyecta estos dos upserts para no acoplarse a schema concreto
  upsertSelectedChannelDB: (
    tenantId: string,
    canal: string,
    contacto: string,
    selected: "whatsapp" | "instagram" | "facebook" | "multi"
  ) => Promise<void>;

  upsertIdiomaClienteDB: (
    tenantId: string,
    canal: string,
    contacto: string,
    idioma: "es" | "en"
  ) => Promise<void>;
}) {
  const { tenantId, canal, contacto, effects } = opts;
  const aw = effects?.awaiting;
  if (!aw) return;

  // 1) clear awaiting si aplica
  if (aw.clear) {
    await clearAwaitingState(tenantId, canal, contacto);
  }

  // 2) persistir el valor capturado
  const field = String(aw.field || "");
  const value = aw.value;

  // Mapea tus fields de awaiting a “upserts” correctos.
  if (field === "select_channel" || field === "canal" || field === "canal_a_automatizar") {
    if (value === "whatsapp" || value === "instagram" || value === "facebook" || value === "multi") {
      await opts.upsertSelectedChannelDB(tenantId, canal, contacto, value);
    }
    return;
  }

  if (field === "select_language") {
    if (value === "es" || value === "en") {
      await opts.upsertIdiomaClienteDB(tenantId, canal, contacto, value);
    }
    return;
  }

  // collect_* por ahora: hook listo, sin persistencia aquí
}
