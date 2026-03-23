import type { Pool } from "pg";
import type { Lang } from "../../../channels/engine/clients/clientDb";
import type { FastpathCtx } from "../../runFastpath";

type PendingLinkOption = {
  label: string;
  url: string;
};

type HandlePendingLinkSelectionInput = {
  userInput: string;
  idiomaDestino: Lang;
  convoCtx: Partial<FastpathCtx> | null | undefined;
  pool: Pool;
  normalizeText: (input: string) => string;
  bestNameMatch: (input: string, list: any[]) => any;
  intentOut?: string | null;
};

type HandlePendingLinkSelectionResult =
  | { handled: false }
  | {
      handled: true;
      reply: string;
      source: "service_list_db";
      intent: string;
      ctxPatch: Partial<FastpathCtx>;
    };

type VariantLookupRow = {
  id: string | null;
  variant_name: string | null;
  description: string | null;
  variant_url: string | null;
  service_description: string | null;
};

type ServiceDescriptionRow = {
  description: string | null;
};

function getPendingLinkState(convoCtx: Partial<FastpathCtx> | null | undefined) {
  const ttlMs = 5 * 60 * 1000;

  const pendingLinkLookup = Boolean(convoCtx?.pending_link_lookup);
  const pendingLinkAt = Number(convoCtx?.pending_link_at || 0);
  const pendingLinkOptions = Array.isArray(convoCtx?.pending_link_options)
    ? (convoCtx.pending_link_options as PendingLinkOption[])
    : [];

  const pendingFresh =
    pendingLinkLookup &&
    pendingLinkOptions.length > 0 &&
    Number.isFinite(pendingLinkAt) &&
    pendingLinkAt > 0 &&
    Date.now() - pendingLinkAt <= ttlMs;

  return {
    pendingFresh,
    pendingLinkOptions,
  };
}

function pickNumericOption(
  userInput: string,
  pendingLinkOptions: PendingLinkOption[]
): PendingLinkOption | null {
  const m = String(userInput || "").trim().match(/^([1-9])$/);
  const idx = m ? Number(m[1]) : null;

  if (idx == null) return null;

  const i = idx - 1;
  if (i < 0 || i >= pendingLinkOptions.length) return null;

  return pendingLinkOptions[i] || null;
}

function pickNamedOption(
  userInput: string,
  pendingLinkOptions: PendingLinkOption[],
  normalizeText: (input: string) => string,
  bestNameMatch: (input: string, list: any[]) => any
): PendingLinkOption | null {
  const byName = bestNameMatch(
    userInput,
    pendingLinkOptions.map((o) => ({
      name: String(o.label || "").trim(),
      url: String(o.url || "").trim(),
    }))
  ) as any;

  if (!byName?.name) return null;

  return (
    pendingLinkOptions.find(
      (o) =>
        normalizeText(String(o.label || "")) ===
        normalizeText(String(byName.name || ""))
    ) || null
  );
}

async function loadVariantByServiceAndChoice(
  pool: Pool,
  serviceId: string,
  finalUrl: string,
  optionLabel: string
): Promise<VariantLookupRow | null> {
  const { rows } = await pool.query<VariantLookupRow>(
    `
    SELECT
      v.id,
      v.variant_name,
      v.description,
      v.variant_url,
      s.description AS service_description
    FROM service_variants v
    JOIN services s
      ON s.id = v.service_id
    WHERE v.service_id = $1
      AND v.active = true
      AND (
        lower(trim(coalesce(v.variant_url, ''))) = lower(trim($2))
        OR lower(trim(coalesce(v.variant_name, ''))) = lower(trim($3))
      )
    ORDER BY
      CASE
        WHEN lower(trim(coalesce(v.variant_url, ''))) = lower(trim($2)) THEN 0
        ELSE 1
      END,
      v.created_at ASC,
      v.id ASC
    LIMIT 1
    `,
    [serviceId, finalUrl, optionLabel]
  );

  return rows[0] || null;
}

async function loadServiceDescription(
  pool: Pool,
  serviceId: string
): Promise<string> {
  const { rows } = await pool.query<ServiceDescriptionRow>(
    `
    SELECT description
    FROM services
    WHERE id = $1
    LIMIT 1
    `,
    [serviceId]
  );

  return String(rows[0]?.description || "").trim();
}

function renderBulletLines(text: string): string {
  if (!text) return "";

  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `• ${l}`)
    .join("\n");
}

function buildReply(args: {
  idiomaDestino: Lang;
  title: string;
  bullets: string;
  finalUrl: string;
}): string {
  const { idiomaDestino, title, bullets, finalUrl } = args;

  const intro = idiomaDestino === "en" ? "Perfect 😊" : "Perfecto 😊";
  const linkLabel = idiomaDestino === "en" ? "Here’s the link:" : "Aquí tienes el link:";
  const outro =
    idiomaDestino === "en"
      ? "If you need anything else, just let me know 😊"
      : "Si necesitas algo más, avísame 😊";

  return `${intro}\n\n${title}${bullets ? `\n\n${bullets}` : ""}\n\n${linkLabel}\n${finalUrl}\n\n${outro}`;
}

export async function handlePendingLinkSelection(
  input: HandlePendingLinkSelectionInput
): Promise<HandlePendingLinkSelectionResult> {
  const {
    userInput,
    idiomaDestino,
    convoCtx,
    pool,
    normalizeText,
    bestNameMatch,
    intentOut,
  } = input;

  const { pendingFresh, pendingLinkOptions } = getPendingLinkState(convoCtx);

  if (!pendingFresh) {
    return { handled: false };
  }

  let pickedOption = pickNumericOption(userInput, pendingLinkOptions);

  if (!pickedOption) {
    pickedOption = pickNamedOption(
      userInput,
      pendingLinkOptions,
      normalizeText,
      bestNameMatch
    );
  }

  if (!pickedOption?.url) {
    return { handled: false };
  }

  const serviceId = String(convoCtx?.last_service_id || "").trim();
  const baseName = String(convoCtx?.last_service_name || "").trim();
  const optionLabel = String(pickedOption.label || "").trim();
  const finalUrl = String(pickedOption.url || "").trim();

  let variantId: string | null = null;
  let variantName = optionLabel;
  let variantDescription = "";
  let serviceDescription = "";

  if (serviceId) {
    const variant = await loadVariantByServiceAndChoice(
      pool,
      serviceId,
      finalUrl,
      optionLabel
    );

    if (variant) {
      variantId = String(variant.id || "").trim() || null;
      variantName = String(variant.variant_name || optionLabel || "").trim();
      serviceDescription = String(variant.service_description || "").trim();
      variantDescription =
        String(variant.description || "").trim() || serviceDescription;
    } else {
      serviceDescription = await loadServiceDescription(pool, serviceId);
      variantDescription = serviceDescription;
    }
  }

  const title =
    baseName && variantName
      ? `${baseName} — ${variantName}`
      : baseName || variantName || "";

  const bullets = renderBulletLines(variantDescription);

  const reply = buildReply({
    idiomaDestino,
    title,
    bullets,
    finalUrl,
  });

  console.log("[FASTPATH][PENDING_LINK_SELECTION][VARIANT_REPLY]", {
    userInput,
    serviceId,
    baseName,
    optionLabel,
    variantName,
    hasVariantDescription: !!variantDescription,
    finalUrl,
  });

  const now = Date.now();

  return {
    handled: true,
    reply,
    source: "service_list_db",
    intent: intentOut || "seleccion",
    ctxPatch: {
      pending_link_lookup: undefined,
      pending_link_at: undefined,
      pending_link_options: undefined,

      last_price_option_label: optionLabel || null,
      last_price_option_at: now,

      last_variant_id: variantId,
      last_variant_name: variantName || null,
      last_variant_url: finalUrl || null,
      last_variant_at: now,

      last_bot_action: "sent_link_option",
      last_bot_action_at: now,
    },
  };
}