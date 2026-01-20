import crypto from "crypto";

function sha256(str: string) {
  return crypto.createHash("sha256").update(str.trim().toLowerCase()).digest("hex");
}

export async function sendMetaPurchase({
  pixelId,
  accessToken,
  eventId,
  eventSourceUrl,
  email,
  value,
  currency,
}: {
  pixelId: string;
  accessToken: string;
  eventId: string;
  eventSourceUrl: string;
  email?: string | null;
  value: number;
  currency: string;
}) {
  const payload = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: eventSourceUrl,
        user_data: {
          em: email ? [sha256(email)] : [],
        },
        custom_data: {
          value,
          currency,
        },
      },
    ],
  };

  const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`Meta CAPI error: ${JSON.stringify(json)}`);

  return json;
}
