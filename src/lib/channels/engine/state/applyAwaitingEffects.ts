import type { Pool } from "pg";
import type { SelectedChannel } from "../clients/clientDb";
import { setAwaitingState } from "../../../awaiting/setAwaitingState";
import { clearAwaitingState } from "../../../awaiting/clearAwaitingState";

type Effects = {
  awaiting?: {
    clear?: boolean;
    field?: string;
    value?: any;        // lo que parseó validateAwaitingInput
    payload?: any;      // payload original
    ttlSeconds?: number;
  };
  idioma?: { value: "es" | "en" };

  // ✅ FIX: selected_channel NO es string, es SelectedChannel
  selected_channel?: { value: SelectedChannel };
};

export async function applyAwaitingEffects(opts: {
  tenantId: string;
  canal: string;
  contacto: string;
  effects: Effects;

  // ✅ FIX: selected también debe ser SelectedChannel
  upsertSelectedChannelDB?: (
    tenantId: string,
    canal: string,
    contacto: string,
    selected: SelectedChannel
  ) => Promise<any>;

  upsertIdiomaClienteDB?: (
    tenantId: string,
    canal: string,
    contacto: string,
    idioma: "es" | "en"
  ) => Promise<any>;

  pool?: Pool;
}) {
  const { tenantId, canal, contacto, effects } = opts;

  const pool = opts.pool;
  if (!pool) throw new Error("applyAwaitingEffects requires pool");

  // =========================
  // Awaiting effects
  // =========================
  if (effects?.awaiting) {
    const a = effects.awaiting;

    if (a.clear) {
      await clearAwaitingState(pool, tenantId, canal, contacto);
    } else if (a.field) {
      await setAwaitingState(pool, {
        tenantId,
        canal,
        senderId: contacto,
        field: a.field,
        payload: {
          ...(a.payload || {}),
          ...(typeof a.value !== "undefined" ? { value: a.value } : {}),
        },
        ttlSeconds: Number(a.ttlSeconds || 600),
      });
    }
  }

  // =========================
  // Other effects (idioma / selected_channel)
  // =========================
  if (effects?.idioma?.value && opts.upsertIdiomaClienteDB) {
    await opts.upsertIdiomaClienteDB(tenantId, canal, contacto, effects.idioma.value);
  }

  if (effects?.selected_channel?.value && opts.upsertSelectedChannelDB) {
    await opts.upsertSelectedChannelDB(
      tenantId,
      canal,
      contacto,
      effects.selected_channel.value
    );
  }
}
