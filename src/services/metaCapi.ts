// src/services/metaCapi.ts
import fetch from "node-fetch";
import pool from "../lib/db";
import crypto from "crypto";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

type CapiEvent = {
  tenantId: string;
  eventName: string;
  eventId?: string;              // ✅ para dedupe de Meta (reintentos)
  eventTime?: number;
  userData?: Record<string, any>;
  customData?: Record<string, any>;
};

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");

export async function sendCapiEvent({
  tenantId,
  eventName,
  eventId,
  eventTime = Math.floor(Date.now() / 1000),
  userData = {},
  customData = {},
}: CapiEvent) {
  try {
    // 1) Leer pixel/token del tenant (✅ multi-tenant)
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
      console.log("CAPI: Pixel no configurado para tenant:", tenantId);
      return;
    }

    // 2) Payload PRODUCCIÓN (sin META_TEST_EVENT_CODE)
    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: eventTime,
          action_source: "chat",
          ...(eventId ? { event_id: eventId } : {}), // ✅ dedupe
          user_data: {
            external_id:
              userData?.external_id || sha256(`${tenantId}:${eventName}:${eventTime}`),
            ...userData,
          },
          custom_data: customData,
        },
      ],
    };

    // 3) Enviar evento
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${accessToken}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await resp.json();
    console.log("CAPI → Meta resp:", result);
    return result;
  } catch (e) {
    console.error("❌ Error en sendCapiEvent:", e);
  }
}
