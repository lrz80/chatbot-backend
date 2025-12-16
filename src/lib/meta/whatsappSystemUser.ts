// backend/src/lib/meta/whatsappSystemUser.ts
import fetch from "node-fetch";

/**
 * Helpers de Graph API para:
 * - Resolver business_id dueño de un WABA
 * - Crear System User en ese business
 * - Generar token del System User para tu APP (con scopes WA)
 * - Registrar phone_number_id (PIN 2-step) usando el system user token
 *
 * Nota: Meta devuelve respuestas con formas variables. Para no pelear con TS,
 * tipamos las respuestas como any y validamos en runtime.
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v18.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type GraphError = { error?: { message?: string } };

function must<T>(value: T, message: string): T {
  if (value === undefined || value === null || (value as any) === "") {
    throw new Error(message);
  }
  return value;
}

async function graphPost(path: string, token: string, body: any): Promise<any> {
  const url = `${GRAPH_BASE}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  const json: any = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    const msg = (json as GraphError)?.error?.message || res.statusText;
    throw new Error(`[GRAPH POST ${path}] ${msg}`);
  }
  return json;
}

async function graphGet(path: string, token: string): Promise<any> {
  const url = `${GRAPH_BASE}/${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  const json: any = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    const msg = (json as GraphError)?.error?.message || res.statusText;
    throw new Error(`[GRAPH GET ${path}] ${msg}`);
  }
  return json;
}

/**
 * Intenta resolver el BUSINESS MANAGER ID dueño del WABA.
 * OJO: Meta a veces expone owner_business, otras business, otras on_behalf_of_business.
 */
export async function resolveBusinessIdFromWaba(wabaId: string, userToken: string): Promise<string> {
  must(wabaId, "wabaId requerido");
  must(userToken, "userToken requerido");

  // Intento A: owner_business
  try {
    const a: any = await graphGet(`${wabaId}?fields=owner_business`, userToken);
    const id = a?.owner_business?.id;
    if (id) return String(id);
  } catch {
    // noop
  }

  // Intento B: business
  try {
    const b: any = await graphGet(`${wabaId}?fields=business`, userToken);
    const id = b?.business?.id;
    if (id) return String(id);
  } catch {
    // noop
  }

  // Intento C: on_behalf_of_business (fallback)
  try {
    const c: any = await graphGet(`${wabaId}?fields=on_behalf_of_business`, userToken);
    const id = c?.on_behalf_of_business?.id;
    if (id) return String(id);
  } catch {
    // noop
  }

  throw new Error(
    "No pude resolver el business_id dueño del WABA. " +
      "El token no tiene permisos suficientes o el asset no expone el campo."
  );
}

/**
 * Crea un System User dentro del Business del tenant y genera un token para TU APP.
 * Requiere que userToken tenga permisos para administrar ese Business.
 *
 * Devuelve: { systemUserId, systemUserToken }
 */
export async function createSystemUserAndTokenForBusiness(params: {
  businessId: string;
  userToken: string;
  appId?: string;
  systemUserName?: string;
}): Promise<{ systemUserId: string; systemUserToken: string }> {
  const { businessId, userToken } = params;
  const appId = params.appId || process.env.META_APP_ID;
  const systemUserName = params.systemUserName || "Aamy API System User";

  must(businessId, "businessId requerido");
  must(userToken, "userToken requerido");
  must(appId, "META_APP_ID requerido (env o params.appId)");

  // 1) Crear System User en el business
  // Endpoint: POST /{businessId}/system_users
  // Campos típicos: name, role
  const su: any = await graphPost(`${businessId}/system_users`, userToken, {
    name: systemUserName,
    role: "ADMIN",
  });

  const systemUserId = must(su?.id, "No se pudo crear system user (sin id)");

  // 2) Generar token del System User para tu APP con scopes WA
  // Endpoint: POST /{systemUserId}/access_tokens
  // Campos: app_id, scope
  // Meta acepta "scope" como string CSV o array.
  const tokenRes: any = await graphPost(`${systemUserId}/access_tokens`, userToken, {
    app_id: String(appId),
    scope: [
      "whatsapp_business_messaging",
      "whatsapp_business_management",
      // business_management a veces se requiere para administrar assets
      "business_management",
    ],
  });

  const systemUserToken = must(
    tokenRes?.access_token,
    "No se pudo generar access_token para system user"
  );

  return {
    systemUserId: String(systemUserId),
    systemUserToken: String(systemUserToken),
  };
}

/**
 * Registra el número (PIN 2-step) usando el SYSTEM USER TOKEN.
 * Endpoint: POST /{phoneNumberId}/register
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
  return await graphPost(`${phoneNumberId}/register`, systemUserToken, {
    messaging_product: "whatsapp",
    pin: String(pin),
  });
}

/**
 * Utilidad: obtiene info del phone_number_id (útil para debug)
 */
export async function getPhoneNumberInfo(params: {
  phoneNumberId: string;
  token: string;
}): Promise<any> {
  const { phoneNumberId, token } = params;
  must(phoneNumberId, "phoneNumberId requerido");
  must(token, "token requerido");

  return await graphGet(`${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status`, token);
}
