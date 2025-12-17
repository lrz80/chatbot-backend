// backend/src/lib/meta/whatsappSystemUser.ts
import fetch from "node-fetch";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function must<T>(
  value: T,
  msg: string
): T {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim())
  ) {
    throw new Error(msg);
  }
  return value;
}

type GraphError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
};

type GraphBaseResponse = {
  error?: GraphError;
  [k: string]: any;
};

async function graphGet(path: string, token: string): Promise<GraphBaseResponse> {
  const url = `${GRAPH_BASE}/${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  const json = (await res.json().catch(() => ({}))) as GraphBaseResponse;

  if (!res.ok) {
    throw new Error(`[GRAPH GET ${path}] ${json?.error?.message || res.statusText}`);
  }
  return json;
}

async function graphPost(
  path: string,
  token: string,
  body: Record<string, any>
): Promise<GraphBaseResponse> {
  const url = `${GRAPH_BASE}/${path}`;

  const form = new URLSearchParams();
  Object.entries(body || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    form.append(k, String(v));
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const json = (await res.json().catch(() => ({}))) as GraphBaseResponse;

  if (!res.ok) {
    throw new Error(`[GRAPH POST ${path}] ${json?.error?.message || res.statusText}`);
  }
  return json;
}

/**
 * Intenta resolver el BUSINESS MANAGER ID dueño del WABA.
 *
 * Orden:
 * A) owner_business
 * B) business
 * C) on_behalf_of_business
 * D) Fallback robusto:
 *    - /me/businesses
 *    - /{businessId}/owned_whatsapp_business_accounts
 *    - si aparece el wabaId => ese businessId es el owner BM
 */
export async function resolveBusinessIdFromWaba(
  wabaId: string,
  userToken: string
): Promise<string> {
  must(wabaId, "wabaId requerido");
  must(userToken, "userToken requerido");

  // A) owner_business
  try {
    const a = await graphGet(`${wabaId}?fields=owner_business`, userToken);
    const id = a?.owner_business?.id;
    if (id) return String(id);
  } catch {
    // ignore
  }

  // B) business
  try {
    const b = await graphGet(`${wabaId}?fields=business`, userToken);
    const id = b?.business?.id;
    if (id) return String(id);
  } catch {
    // ignore
  }

  // C) on_behalf_of_business
  try {
    const c = await graphGet(`${wabaId}?fields=on_behalf_of_business`, userToken);
    const id = c?.on_behalf_of_business?.id;
    if (id) return String(id);
  } catch {
    // ignore
  }

  // D) Fallback robusto
  // 1) Listar Businesses del usuario
  const meBusinesses = await graphGet(`me/businesses?fields=id,name&limit=200`, userToken);
  const businesses: Array<{ id: string; name?: string }> = Array.isArray(meBusinesses?.data)
    ? meBusinesses.data
    : [];

  if (!businesses.length) {
    throw new Error(
      "No pude resolver business manager id: /me/businesses devolvió vacío. Revisa permisos business_management."
    );
  }

  // 2) Para cada Business, ver sus WABAs owned
  for (const b of businesses) {
    try {
      const owned = await graphGet(
        `${b.id}/owned_whatsapp_business_accounts?fields=id,name&limit=200`,
        userToken
      );

      const wabas: Array<{ id: string }> = Array.isArray(owned?.data) ? owned.data : [];
      const match = wabas.some((x) => String(x.id) === String(wabaId));

      if (match) {
        return String(b.id); // ✅ ESTE ES el whatsapp_business_manager_id
      }
    } catch {
      // si una business falla por permisos, seguimos con las demás
      continue;
    }
  }

  throw new Error(
    "No pude resolver el whatsapp_business_manager_id del WABA. " +
      "Revisa permisos del token (business_management) y que el usuario sea admin/owner del Business que posee el WABA."
  );
}

/**
 * Crea un System User dentro del Business (BM) del tenant.
 * NOTA: Este system user queda creado dentro del BM del cliente.
 */
export async function createSystemUser(params: {
  businessId: string;
  userToken: string;
  name?: string;
  role?: "ADMIN" | "EMPLOYEE";
}): Promise<string> {
  const { businessId, userToken } = params;
  must(businessId, "businessId requerido");
  must(userToken, "userToken requerido");

  const name = params.name || "Aamy WhatsApp System User";
  const role = params.role || "ADMIN";

  // POST /{businessId}/system_users
  const su = await graphPost(`${businessId}/system_users`, userToken, {
    name,
    role,
  });

  const systemUserId = su?.id;
  return must(String(systemUserId), "No se pudo crear system user (sin id)");
}

/**
 * Genera token del System User para tu APP.
 * IMPORTANTE:
 * - app_id: ID de tu app
 * - scope: CSV
 */
export async function createSystemUserToken(params: {
  systemUserId: string;
  userToken: string;
  appId: string;
  scopesCsv?: string;
}): Promise<string> {
  const { systemUserId, userToken, appId } = params;
  must(systemUserId, "systemUserId requerido");
  must(userToken, "userToken requerido");
  must(appId, "appId requerido");

  const scope =
    params.scopesCsv ||
    "whatsapp_business_management,whatsapp_business_messaging,business_management";

  // POST /{systemUserId}/access_tokens
  const tokenRes = await graphPost(`${systemUserId}/access_tokens`, userToken, {
    app_id: appId,
    scope,
  });

  const accessToken = tokenRes?.access_token;
  return must(String(accessToken), "No se pudo generar access_token para system user");
}

/**
 * Registra el phone_number_id con PIN usando SYSTEM USER TOKEN.
 * Esto es lo que normalmente quita el “PENDING”.
 */
export async function registerPhoneNumber(params: {
  phoneNumberId: string;
  systemUserToken: string;
  pin: string;
}): Promise<any> {
  const { phoneNumberId, systemUserToken, pin } = params;
  must(phoneNumberId, "phoneNumberId requerido");
  must(systemUserToken, "systemUserToken requerido");
  must(pin, "pin requerido");

  // POST /{phoneNumberId}/register
  return graphPost(`${phoneNumberId}/register`, systemUserToken, {
    messaging_product: "whatsapp",
    pin,
  });
}

export async function subscribeAppToWaba(wabaId: string, userToken: string) {
  must(wabaId, "wabaId requerido");
  must(userToken, "userToken requerido");

  // POST /{wabaId}/subscribed_apps
  return graphPost(`${wabaId}/subscribed_apps`, userToken, {});
}

export async function getSubscribedAppsFromWaba(wabaId: string, userToken: string) {
  must(wabaId, "wabaId requerido");
  must(userToken, "userToken requerido");

  // GET /{wabaId}/subscribed_apps
  return graphGet(`${wabaId}/subscribed_apps`, userToken);
}

