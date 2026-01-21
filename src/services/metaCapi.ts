// src/services/metaCapi.ts
import fetch from "node-fetch";
import pool from "../lib/db";
import crypto from "crypto";

type CapiEvent = {
  tenantId: string;
  eventName: string;
  eventTime?: number;
  userData?: Record<string, any>;
  customData?: Record<string, any>;
};

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");

export async function sendCapiEvent({
  tenantId,
  eventName,
  eventTime = Math.floor(Date.now() / 1000),
  userData = {},
  customData = {},
}: CapiEvent) {
  try {
    // 1) Leer pixel del tenant
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

    // 2) Construir payload para Meta CAPI
    const payload = {
        data: [
            {
            event_name: eventName,
            event_time: eventTime,
            action_source: "chat",
            user_data: {
                external_id: userData?.external_id || sha256(`${tenantId}:${eventName}:${eventTime}`),
                ...userData,
            },
            custom_data: customData,
            },
        ],
        test_event_code: process.env.META_TEST_EVENT_CODE,
        };

    // 3) Enviar evento CAPI
    const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;
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
