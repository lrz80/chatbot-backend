// src/services/metaCapi.ts
import fetch from "node-fetch";
import pool from "../lib/db";
import crypto from "crypto";

type CapiEvent = {
  tenantId: string;
  eventName: string;
  eventTime?: number;
  eventId?: string;                // ✅ dedupe real
  actionSource?: string;           // ✅ por defecto "chat"
  eventSourceUrl?: string;         // ✅ opcional
  userData?: Record<string, any>;
  customData?: Record<string, any>;
};

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");

export async function sendCapiEvent({
  tenantId,
  eventName,
  eventTime = Math.floor(Date.now() / 1000),
  eventId,
  actionSource = "chat",
  eventSourceUrl,
  userData = {},
  customData = {},
}: CapiEvent) {
  try {
    const res = await pool.query(
      `SELECT settings FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    if (!res.rows.length) return;

    let settings = res.rows[0].settings || {};
    if (typeof settings === "string") {
      try { settings = JSON.parse(settings); } catch { settings = {}; }
    }

    const pixelId = settings?.meta?.pixel_id || null;
    const pixelEnabled = settings?.meta?.pixel_enabled || false;
    const accessToken = settings?.meta?.capi_token || null;

    if (!pixelId || !pixelEnabled || !accessToken) {
      console.log("CAPI OPCIONAL: Pixel no configurado para tenant:", tenantId);
      return;
    }

    // ✅ Importante: external_id debe ser hasheado y preferiblemente en array
    // Si ya te pasan external_id, respétalo; si no, genera uno estable.
    const externalId =
      userData?.external_id ||
      sha256(`${tenantId}:${eventName}:${String(userData?.ph || userData?.email || "")}`);

    const payload: any = {
      data: [
        {
          event_name: eventName,
          event_time: eventTime,
          action_source: actionSource,
          event_id: eventId, // ✅ dedupe real
          event_source_url: eventSourceUrl,
          user_data: {
            // Meta acepta external_id como string o array; array suele ser más consistente
            external_id: Array.isArray(externalId) ? externalId : [externalId],
            ...userData,
          },
          custom_data: customData,
        },
      ],
    };

    const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await resp.json();
    console.log("[CAPI] Meta resp =", JSON.stringify(result));
    return result;
  } catch (e) {
    console.error("❌ Error en sendCapiEvent:", e);
  }
}
