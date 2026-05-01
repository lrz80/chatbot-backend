//src/services/googleCalendar.ts
import crypto from "crypto";
import {
  getBookingProviderSecrets,
  upsertBookingProviderConnection,
} from "../lib/appointments/booking/providers/providerConnections.repo";

export type GoogleBusyBlock = { start: string; end: string };

export type GoogleFreeBusyResponse = {
  calendars?: Record<string, { busy?: GoogleBusyBlock[] }>;
};

function emptyFreeBusy(calendarIds: string[] = ["primary"], degraded = true) {
  const calendars: Record<string, { busy: GoogleBusyBlock[] }> = {};

  for (const id of calendarIds) calendars[id] = { busy: [] };
  calendars["combined"] = { busy: [] };

  return { calendars, degraded };
}

type GoogleTokens = {
  access_token: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

async function markGoogleDisconnected(tenantId: string, reason: string) {
  try {
    await upsertBookingProviderConnection({
      tenantId,
      provider: "google_calendar",
      status: "error",
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      metadata: {
        last_error: reason,
        disconnected_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error("markGoogleDisconnected failed:", e);
  }
}

async function getGoogleProviderRefreshToken(tenantId: string): Promise<string> {
  const secrets = await getBookingProviderSecrets(tenantId, "google_calendar");

  if (!secrets?.refreshToken) {
    throw new Error("google_not_connected");
  }

  return secrets.refreshToken;
}

export async function getGoogleAccessToken(tenantId: string): Promise<string> {
  const refreshToken = await getGoogleProviderRefreshToken(tenantId);

  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    throw new Error("google_oauth_not_configured");
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  const json = (await resp.json()) as GoogleTokens;

  if (!resp.ok || !json.access_token) {
    console.error("Google refresh failed:", resp.status, json);

    if (json?.error === "invalid_grant") {
      await markGoogleDisconnected(tenantId, "invalid_grant");
      throw new Error("google_not_connected");
    }

    await upsertBookingProviderConnection({
      tenantId,
      provider: "google_calendar",
      status: "error",
      accessToken: null,
      refreshToken: refreshToken,
      tokenExpiresAt: null,
      metadata: {
        last_error: `refresh_${resp.status}_${json?.error || "unknown"}`,
        updated_at_source: "google_refresh_failed",
      },
    });

    throw new Error("google_refresh_failed");
  }

  await upsertBookingProviderConnection({
    tenantId,
    provider: "google_calendar",
    status: "active",
    accessToken: json.access_token,
    refreshToken: refreshToken,
    tokenExpiresAt: json.expires_in
      ? new Date(Date.now() + Number(json.expires_in) * 1000).toISOString()
      : null,
    metadata: {
      updated_at_source: "google_refresh_success",
    },
  });

  return json.access_token;
}

export async function googleFreeBusy(params: {
  tenantId: string;
  timeMin: string;
  timeMax: string;
  calendarIds?: string[];
}): Promise<GoogleFreeBusyResponse & { degraded?: boolean }> {
  console.log("🧬 GCAL MODULE LOADED v2026-05-01-provider-connections");

  let accessToken: string;

  try {
    accessToken = await getGoogleAccessToken(params.tenantId);
  } catch (e: any) {
    const msg = String(e?.message || "");

    if (
      msg === "google_not_connected" ||
      msg === "google_refresh_failed" ||
      msg === "google_oauth_not_configured"
    ) {
      const calendarIds =
        params.calendarIds && params.calendarIds.length > 0
          ? params.calendarIds
          : ["primary"];

      console.log("🟡 freeBusy degraded:", {
        tenantId: params.tenantId,
        calendarIds,
      });

      return emptyFreeBusy(calendarIds, true);
    }

    throw e;
  }

  const calendarIds =
    params.calendarIds && params.calendarIds.length > 0
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
      console.log("🟡 freeBusy degraded:", {
        tenantId: params.tenantId,
        calendarIds,
        status: resp.status,
      });
      return emptyFreeBusy(calendarIds, true);
    }

    console.log("🟡 freeBusy degraded:", {
      tenantId: params.tenantId,
      calendarIds,
      status: resp.status,
    });
    return emptyFreeBusy(calendarIds, true);
  }

  const calendars = json?.calendars || {};
  const keys = Object.keys(calendars);

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

  (calendars as any)["combined"] = { busy: allBusy };

  console.log("🗓️ freeBusy combined:", {
    tenantId: params.tenantId,
    calendarIds,
    timeMin: params.timeMin,
    timeMax: params.timeMax,
    busyCount: allBusy.length,
    degraded: false,
  });

  return { ...json, calendars, degraded: false };
}

export async function googleCreateEvent(params: {
  tenantId: string;
  calendarId?: string;
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
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    }
  );

  let json: any = null;
  let rawText = "";

  try {
    rawText = await resp.text();
    json = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    console.error("Google create event parse failed:", {
      tenantId: params.tenantId,
      calendarId: params.calendarId || "primary",
      status: resp.status,
      rawText,
      error,
    });
    json = null;
  }

  if (!resp.ok) {
    console.error("Google create event failed:", {
      tenantId: params.tenantId,
      calendarId: params.calendarId || "primary",
      status: resp.status,
      body: json,
      rawText,
    });

    if (resp.status === 401 || resp.status === 403) {
      await markGoogleDisconnected(params.tenantId, `create_${resp.status}`);
      throw new Error("google_not_connected");
    }

    throw new Error("google_create_event_failed");
  }

  const meetLink =
    json?.hangoutLink ||
    json?.conferenceData?.entryPoints?.find((e: any) => e?.entryPointType === "video")?.uri ||
    null;

  if (
    json &&
    meetLink &&
    typeof json.description === "string" &&
    !json.description.includes(meetLink)
  ) {
    json.description = `${json.description}\n\nGoogle Meet: ${meetLink}`.trim();
  }

  if (json) {
    json.meetLink = meetLink;
  }

  const createdEventId = String(json?.id || "").trim();

  if (!createdEventId) {
    console.error("Google create event returned success without id:", {
      tenantId: params.tenantId,
      calendarId: params.calendarId || "primary",
      status: resp.status,
      body: json,
      rawText,
    });

    throw new Error("google_create_event_missing_id");
  }

  const verified = await googleGetEvent({
    accessToken,
    calendarId,
    eventId: createdEventId,
  });

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

  const finalEvent = verified || json;

  if (!finalEvent?.id) {
    console.error("Google create event verification missing id:", {
      tenantId: params.tenantId,
      calendarId: params.calendarId || "primary",
      createdEventId,
      verified,
      json,
    });

    throw new Error("google_create_event_missing_id");
  }

  return finalEvent;
}

async function googleGetEvent(args: {
  accessToken: string;
  calendarId: string;
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

export async function googleDeleteEvent(params: {
  tenantId: string;
  calendarId?: string;
  eventId: string;
}) {
  let accessToken: string;

  try {
    accessToken = await getGoogleAccessToken(params.tenantId);
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (
      msg === "google_not_connected" ||
      msg === "google_refresh_failed" ||
      msg === "google_oauth_not_configured"
    ) {
      throw new Error("google_not_connected");
    }
    throw e;
  }

  const calendarId = encodeURIComponent(params.calendarId || "primary");
  const eventId = encodeURIComponent(String(params.eventId || "").trim());

  if (!eventId) throw new Error("missing_event_id");

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (resp.status === 204) {
    return { ok: true };
  }

  const body = await resp.json().catch(() => ({} as any));

  if (resp.status === 401 || resp.status === 403) {
    await markGoogleDisconnected(params.tenantId, `delete_${resp.status}`);
    throw new Error("google_not_connected");
  }

  if (resp.status === 404) {
    return { ok: true, already_missing: true };
  }

  console.error("Google delete event failed:", { status: resp.status, body });
  throw new Error("google_delete_event_failed");
}

export async function googleUpdateEvent(params: {
  tenantId: string;
  calendarId?: string;
  eventId: string;
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
    if (
      msg === "google_not_connected" ||
      msg === "google_refresh_failed" ||
      msg === "google_oauth_not_configured"
    ) {
      throw new Error("google_not_connected");
    }
    throw e;
  }

  const calendarId = encodeURIComponent(params.calendarId || "primary");
  const eventId = encodeURIComponent(String(params.eventId || "").trim());

  if (!eventId) throw new Error("missing_event_id");

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}?conferenceDataVersion=1`,
    {
      method: "PATCH",
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

  const json = await resp.json().catch(() => ({} as any));

  const meetLink =
    json?.hangoutLink ||
    json?.conferenceData?.entryPoints?.find((e: any) => e?.entryPointType === "video")?.uri;

  if (meetLink && typeof json?.description === "string" && !json.description.includes(meetLink)) {
    json.description = `${json.description}\n\nGoogle Meet: ${meetLink}`.trim();
  }

  json.meetLink = meetLink || null;

  if (!resp.ok) {
    console.error("Google update event failed:", { status: resp.status, body: json });

    if (resp.status === 401 || resp.status === 403) {
      await markGoogleDisconnected(params.tenantId, `update_${resp.status}`);
      throw new Error("google_not_connected");
    }

    if (resp.status === 404) {
      throw new Error("google_event_not_found");
    }

    throw new Error("google_update_event_failed");
  }

  const verified = params.eventId
    ? await googleGetEvent({
        accessToken,
        calendarId,
        eventId: String(params.eventId || "").trim(),
      })
    : null;

  console.log("🟣 [GCAL UPDATE]", {
    tenantId: params.tenantId,
    calendarId: params.calendarId || "primary",
    eventId: json?.id || params.eventId,
    htmlLink_update: json?.htmlLink,
    status_update: json?.status,
    organizer_update: json?.organizer?.email,
    creator_update: json?.creator?.email,
  });

  console.log("🟢 [GCAL GET VERIFY AFTER UPDATE]", {
    tenantId: params.tenantId,
    calendarId: params.calendarId || "primary",
    eventId: verified?.id || params.eventId || null,
    htmlLink_get: verified?.htmlLink || null,
    status_get: verified?.status || null,
    organizer_get: verified?.organizer?.email || null,
    creator_get: verified?.creator?.email || null,
    icaluid_get: verified?.iCalUID || null,
  });

  return verified || json;
}