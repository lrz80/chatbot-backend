//src/services/googleCalendar.ts
import pool from "../lib/db";
import { decryptToken } from "./googleCrypto";

type GoogleTokens = { access_token: string; expires_in?: number; token_type?: string };

async function getRefreshTokenEnc(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `
    SELECT refresh_token_enc
    FROM calendar_integrations
    WHERE tenant_id = $1
      AND provider = 'google'
      AND status = 'connected'
    LIMIT 1
    `,
    [tenantId]
  );

  const enc = rows[0]?.refresh_token_enc;
  if (!enc) throw new Error("google_not_connected");
  return enc;
}

export async function getGoogleAccessToken(tenantId: string): Promise<string> {
  const enc = await getRefreshTokenEnc(tenantId);
  const refresh_token = decryptToken(enc);
  if (!refresh_token) throw new Error("google_refresh_token_invalid");

  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) throw new Error("google_oauth_not_configured");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });

  const json = (await resp.json()) as GoogleTokens & { error?: string; error_description?: string };
  if (!resp.ok || !json.access_token) {
    console.error("Google refresh failed:", resp.status, json);
    throw new Error("google_refresh_failed");
  }
  return json.access_token;
}

export async function googleFreeBusy(params: {
  tenantId: string;
  timeMin: string; // ISO
  timeMax: string; // ISO
  calendarId?: string; // default primary
}) {
  const accessToken = await getGoogleAccessToken(params.tenantId);
  const calendarId = params.calendarId || "primary";

  const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      items: [{ id: calendarId }],
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    console.error("Google freebusy failed:", json);
    throw new Error("google_freebusy_failed");
  }
  return json;
}

export async function googleCreateEvent(params: {
  tenantId: string;
  calendarId?: string; // default primary
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone: string;
}) {
  const accessToken = await getGoogleAccessToken(params.tenantId);
  const calendarId = encodeURIComponent(params.calendarId || "primary");

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: params.summary,
        description: params.description || "",
        start: { dateTime: params.startISO, timeZone: params.timeZone },
        end: { dateTime: params.endISO, timeZone: params.timeZone },
      }),
    }
  );

  const json = await resp.json();
  if (!resp.ok) {
    console.error("Google create event failed:", json);
    throw new Error("google_create_event_failed");
  }
  return json;
}
