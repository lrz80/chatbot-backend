import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";

export type HandleResolvedServiceDetailInput = {
  pool: Pool;
  userInput: string;
  idiomaDestino: string;
  intentOut?: string | null;
  hit: any;
  traducirMensaje: (texto: string, idiomaDestino: string) => Promise<string>;
  convoCtx: any;
};

function splitLines(text: string): string[] {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
}

export async function handleResolvedServiceDetail(
  input: HandleResolvedServiceDetailInput
): Promise<FastpathResult> {
  const serviceId = String(input.hit?.serviceId || input.hit?.id || "").trim();

  if (!serviceId) {
    return {
      handled: false,
    };
  }

  const {
    rows: [service],
  } = await input.pool.query<any>(
    `
    SELECT
      id,
      name,
      description,
      service_url
    FROM services
    WHERE id = $1
    LIMIT 1
    `,
    [serviceId]
  );

  if (!service) {
    return {
      handled: false,
    };
  }

  const { rows: variants } = await input.pool.query<any>(
    `
    SELECT
      id,
      variant_name,
      description,
      variant_url,
      price,
      currency
    FROM service_variants
    WHERE service_id = $1
      AND active = true
    ORDER BY created_at ASC, id ASC
    `,
    [serviceId]
  );

  const baseName = String(service.name || "").trim();
  const serviceDescription = String(service.description || "").trim();
  const serviceUrl = service.service_url
    ? String(service.service_url).trim()
    : null;

  // Caso A: el servicio tiene variantes -> listar opciones
  if (variants.length > 0) {
    const variantOptions = variants.map((v: any, idx: number) => ({
      index: idx + 1,
      id: String(v.id || ""),
      name: String(v.variant_name || "").trim(),
      url: v.variant_url ? String(v.variant_url).trim() : null,
      price:
        v.price === null || v.price === undefined || v.price === ""
          ? null
          : Number(v.price),
      currency: String(v.currency || "USD").trim(),
    }));

    const lines = variantOptions.map((v) => `• ${v.index}) ${v.name}`);

    const reply =
      input.idiomaDestino === "en"
        ? `${baseName} has these options:\n\n${lines.join("\n")}\n\nWhich one would you like to know more about? You can reply with the number.`
        : `${baseName} tiene estas opciones:\n\n${lines.join("\n")}\n\n¿Cuál te interesa? Puedes responder con el número.`;

    return {
      handled: true,
      reply,
      source: "service_list_db",
      intent: input.intentOut || "info_servicio",
      ctxPatch: {
        expectingVariant: true,
        expectedVariantIntent: "info_servicio",

        selectedServiceId: serviceId,

        last_service_id: serviceId,
        last_service_name: baseName || null,
        last_service_at: Date.now(),

        last_variant_id: null,
        last_variant_name: null,
        last_variant_url: null,
        last_variant_at: null,

        last_variant_options: variantOptions,
        last_variant_options_at: Date.now(),

        last_bot_action: "asked_service_variant_detail",
        last_bot_action_at: Date.now(),
      } as any,
    };
  }

  // Caso B: no tiene variantes -> responder detalle directo del servicio
  let displayBaseName = baseName;
  let displayDescription = serviceDescription;

  if (input.idiomaDestino === "en") {
    try {
      if (displayBaseName) {
        displayBaseName = await input.traducirMensaje(displayBaseName, "en");
      }
    } catch (e) {
      console.warn(
        "[FASTPATH-SERVICE-DETAIL] error translating service_name:",
        e
      );
    }

    try {
      if (displayDescription) {
        const translatedLines: string[] = [];
        for (const line of splitLines(displayDescription)) {
          translatedLines.push(await input.traducirMensaje(line, "en"));
        }
        displayDescription = translatedLines.join("\n");
      }
    } catch (e) {
      console.warn(
        "[FASTPATH-SERVICE-DETAIL] error translating service_description:",
        e
      );
    }
  }

  const bullets = splitLines(displayDescription)
    .map((line: string) => `• ${line}`)
    .join("\n");

  const title = displayBaseName || "";

  let reply =
    input.idiomaDestino === "en"
      ? `${title}${bullets ? ` includes:\n\n${bullets}` : ""}`
      : `${title}${bullets ? ` incluye:\n\n${bullets}` : ""}`;

  if (serviceUrl) {
    reply +=
      input.idiomaDestino === "en"
        ? `\n\nHere you can see more details:\n${serviceUrl}`
        : `\n\nAquí puedes ver más detalles:\n${serviceUrl}`;
  } else {
    reply +=
      input.idiomaDestino === "en"
        ? `\n\nIf you need anything else, just let me know. 😊`
        : `\n\nSi necesitas algo más, avísame. 😊`;
  }

  console.log("[FASTPATH-SERVICE-DETAIL] resolved service without variants", {
    userInput: input.userInput,
    serviceId,
    baseName,
    hasServiceUrl: !!serviceUrl,
  });

  return {
    handled: true,
    reply,
    source: "service_list_db",
    intent: input.intentOut || "info_servicio",
    ctxPatch: {
      expectingVariant: false,
      expectedVariantIntent: null,

      selectedServiceId: serviceId,

      last_service_id: serviceId,
      last_service_name: baseName || null,
      last_service_at: Date.now(),

      last_variant_id: null,
      last_variant_name: null,
      last_variant_url: serviceUrl || null,
      last_variant_at: null,
    } as any,
  };
}