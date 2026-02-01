//src/services/googleCalendar.ts
import pool from "../lib/db";
import { decryptToken } from "./googleCrypto";
import crypto from "crypto";

export type GoogleBusyBlock = { start: string; end: string };

export type GoogleFreeBusyResponse = {
  calendars?: Record<string, { busy?: GoogleBusyBlock[] }>;
};

function emptyFreeBusy(degraded = true) {
  return { calendars: { combined: { busy: [] } }, degraded };
}

type GoogleTokens = { access_token: string; expires_in?: number; token_type?: string };

async function markGoogleDisconnected(tenantId: string, reason: string) {
  try {
    await pool.query(
      `
      UPDATE calendar_integrations
         SET status = 'disconnected',
             last_error = $2,
             updated_at = NOW()
       WHERE tenant_id = $1
         AND provider = 'google'
      `,
      [tenantId, reason]
    );
  } catch (e) {
    // Nunca dejes que esto tumbe el flujo
    console.error("markGoogleDisconnected failed:", e);
  }
}

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

    // ✅ Caso típico: invalid_grant (revocado/expirado)
    if (json?.error === "invalid_grant") {
      await markGoogleDisconnected(tenantId, "invalid_grant");
      throw new Error("google_not_connected"); // fuerza UI a reconectar
    }

    await pool.query(
      `
      UPDATE calendar_integrations
        SET last_error = $2,
            updated_at = NOW()
      WHERE tenant_id = $1 AND provider='google'
      `,
      [tenantId, `refresh_${resp.status}_${json?.error || "unknown"}`]
    );
    throw new Error("google_refresh_failed");
  }

  return json.access_token;
}

export async function googleFreeBusy(params: {
  tenantId: string;
  timeMin: string; // ISO
  timeMax: string; // ISO
  calendarIds?: string[];
}): Promise<GoogleFreeBusyResponse & { degraded?: boolean }> {
  console.log("🧬 GCAL MODULE LOADED v2026-01-31-B");

  let accessToken: string;

  try {
    accessToken = await getGoogleAccessToken(params.tenantId);
  } catch (e: any) {
    const msg = String(e?.message || "");

    // ✅ Si no hay conexión o refresh murió, degradar: sin busy blocks
    if (
      msg === "google_not_connected" ||
      msg === "google_refresh_failed" ||
      msg === "google_refresh_token_invalid" ||
      msg === "google_oauth_not_configured"
    ) {
      const calendarIds = (params.calendarIds && params.calendarIds.length > 0)
        ? params.calendarIds
        : ["primary"];
      console.log("🟡 freeBusy degraded:", { tenantId: params.tenantId, calendarIds });
      return emptyFreeBusy(true);
    }
    throw e;
  }

  const calendarIds = (params.calendarIds && params.calendarIds.length > 0)
  ? params.calendarIds
  : ["primary"];

  const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      items: calendarIds.map((id) => ({ id })),
    }),
  });

    const json = (await resp.json()) as GoogleFreeBusyResponse & { error?: any };

  if (!resp.ok) {
    console.error("Google freebusy failed:", json);

    if (resp.status === 401 || resp.status === 403) {
      await markGoogleDisconnected(params.tenantId, `freebusy_${resp.status}`);
      console.log("🟡 freeBusy degraded:", { tenantId: params.tenantId, calendarIds, status: resp.status });
      return emptyFreeBusy(true);
    }

    console.log("🟡 freeBusy degraded:", { tenantId: params.tenantId, calendarIds, status: resp.status });
    return emptyFreeBusy(true);
  }

  const calendars = json?.calendars || {};
  const keys = Object.keys(calendars);

  // 🔥 LOG REAL: qué devolvió Google
  console.log("🧪 freeBusy raw keys:", {
    tenantId: params.tenantId,
    requestedCalendarIds: calendarIds,
    keys,
    counts: keys.reduce((acc: any, k) => {
      acc[k] = calendars?.[k]?.busy?.length ?? 0;
      return acc;
    }, {}),
  });

  const allBusy: GoogleBusyBlock[] = [];
  for (const id of calendarIds) {
    const busy = calendars?.[id]?.busy || [];
    for (const b of busy) allBusy.push(b);
  }

  // ✅ si no hubo keys pero la respuesta fue ok, igual devolvemos estructura consistente
  console.log("🗓️ freeBusy combined:", {
    tenantId: params.tenantId,
    calendarIds,
    timeMin: params.timeMin,
    timeMax: params.timeMax,
    busyCount: allBusy.length,
    degraded: false,
  });

  return {
    calendars: {
      // clave virtual: "combined"
      combined: { busy: allBusy },
    },
    degraded: false,
  };
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
    let accessToken: string;
    try {
      accessToken = await getGoogleAccessToken(params.tenantId);
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg === "google_not_connected" || msg === "google_refresh_failed") {
        throw new Error("google_not_connected");
      }
      throw e;
    }

  const calendarId = encodeURIComponent(params.calendarId || "primary");

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1`,
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

        // ✅ Crea Google Meet automáticamente
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    }
  );

  const json = await resp.json().catch(() => ({}));

  // ✅ Si Google devolvió meet link, lo anexamos al description para que sea visible siempre
  const meetLink =
    json?.hangoutLink ||
    json?.conferenceData?.entryPoints?.find((e: any) => e?.entryPointType === "video")?.uri;

  if (meetLink && typeof json?.description === "string" && !json.description.includes(meetLink)) {
    json.description = `${json.description}\n\nGoogle Meet: ${meetLink}`.trim();
  }

  json.meetLink = meetLink || null;

  if (!resp.ok) {
    console.error("Google create event failed:", json);

    if (resp.status === 401 || resp.status === 403) {
      await markGoogleDisconnected(params.tenantId, `create_${resp.status}`);
      throw new Error("google_not_connected");
    }

    throw new Error("google_create_event_failed");
  }

  // ✅ VERIFICACIÓN: GET del evento recién creado
  const createdEventId = String(json?.id || "").trim();

  const verified =
    createdEventId
      ? await googleGetEvent({ accessToken, calendarId, eventId: createdEventId })
      : null;

  console.log("🟣 [GCAL INSERT]", {
    tenantId: params.tenantId,
    calendarId: params.calendarId || "primary",
    eventId: json?.id,
    htmlLink_insert: json?.htmlLink,
    status_insert: json?.status,
    organizer_insert: json?.organizer?.email,
    creator_insert: json?.creator?.email,
  });

  console.log("🟢 [GCAL GET VERIFY]", {
    tenantId: params.tenantId,
    calendarId: params.calendarId || "primary",
    eventId: verified?.id || createdEventId || null,
    htmlLink_get: verified?.htmlLink || null,
    status_get: verified?.status || null,
    organizer_get: verified?.organizer?.email || null,
    creator_get: verified?.creator?.email || null,
    icaluid_get: verified?.iCalUID || null,
  });

  // ✅ Devuelve SIEMPRE el evento verificado si existe
  return verified || json;
}

async function googleGetEvent(args: {
  accessToken: string;
  calendarId: string; // ya URL-encoded
  eventId: string;
}) {
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${args.calendarId}/events/${encodeURIComponent(args.eventId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  const j = await r.json().catch(() => ({}));

  if (!r.ok) {
    console.error("Google get event failed:", { status: r.status, body: j });
    return null;
  }

  return j;
}
