import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";

export type HandleVariantSecondTurnInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
  detectedIntent?: string | null;
  intentOut?: string | null;
  catalogReferenceClassification?: any;

  answerWithPromptBase: (input: any) => Promise<{ text: string }>;

  promptBase: string;
  canal: any;
};

function parseSingleDigitSelection(input: string): number | null {
  const value = String(input || "").trim();
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 1 || parsed > 9) return null;
  if (String(parsed) !== value) return null;

  return parsed;
}

function splitLines(text: string): string[] {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
}

export async function handleVariantSecondTurn(
  input: HandleVariantSecondTurnInput
): Promise<FastpathResult> {
  const {
    targetServiceId: structuredTargetServiceId,
    targetVariantId,
    targetFamilyKey,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
  });

  const classifiedIntentNow = String(
    input.catalogReferenceClassification?.intent || ""
  )
    .trim()
    .toLowerCase();

  const detectedIntentNow = String(input.detectedIntent || "")
    .trim()
    .toLowerCase();

  const explicitDetailIntentNow =
    classifiedIntentNow === "includes" ||
    detectedIntentNow === "info_servicio";

  const numericSelectionIndex = parseSingleDigitSelection(input.userInput);

  const selectedServiceId =
    String(
      structuredTargetServiceId ||
        input.convoCtx?.selectedServiceId ||
        input.convoCtx?.last_service_id ||
        ""
    ).trim() || null;

  const hasVariantSelectionContext =
    Boolean(input.convoCtx?.expectingVariant) ||
    Boolean(
      selectedServiceId &&
        (input.convoCtx?.last_service_id ||
          input.convoCtx?.last_service_name ||
          input.convoCtx?.last_variant_name ||
          input.convoCtx?.last_price_option_label ||
          (Array.isArray(input.convoCtx?.last_catalog_plans) &&
            input.convoCtx.last_catalog_plans.length > 0) ||
          (Array.isArray(input.convoCtx?.pending_link_options) &&
            input.convoCtx.pending_link_options.length > 0) ||
          (Array.isArray(input.convoCtx?.last_variant_options) &&
            input.convoCtx.last_variant_options.length > 0))
    );

  const shouldSkipVariantSelection = explicitDetailIntentNow;

  const canAttemptVariantResolution =
    !shouldSkipVariantSelection &&
    Boolean(selectedServiceId) &&
    (hasVariantSelectionContext || Boolean(targetVariantId)) &&
    (Boolean(targetVariantId) || numericSelectionIndex !== null);

  if (!canAttemptVariantResolution) {
    return {
      handled: false,
    };
  }

  console.log("[VARIANT_SECOND_TURN][ENTRY]", {
    userInput: input.userInput,
    expectingVariant: input.convoCtx?.expectingVariant,
    selectedServiceId,
    hasVariantSelectionContext,
    numericSelectionIndex,
    targetVariantId,
    targetFamilyKey,
    shouldSkipVariantSelection,
  });

  const serviceId = String(selectedServiceId);

  const askedPriceVariant =
    String(input.convoCtx?.last_bot_action || "") === "asked_price_variant";

  const storedVariantOptions = Array.isArray(input.convoCtx?.last_variant_options)
    ? input.convoCtx.last_variant_options
    : [];

  if (askedPriceVariant && storedVariantOptions.length > 0) {
    let chosenOption: any = null;

    if (targetVariantId) {
      chosenOption =
        storedVariantOptions.find(
          (v: any) => String(v.id || "") === String(targetVariantId)
        ) || { id: String(targetVariantId) };
    }

    if (!chosenOption && numericSelectionIndex !== null) {
      chosenOption =
        storedVariantOptions.find(
          (v: any) => Number(v.index) === numericSelectionIndex
        ) || null;
    }

    if (chosenOption?.id) {
      const {
        rows: [chosenRow],
      } = await input.pool.query<any>(
        `
        SELECT
          v.id,
          v.variant_name,
          v.description,
          v.variant_url,
          v.price,
          v.currency,
          s.name AS service_name,
          s.service_url
        FROM service_variants v
        JOIN services s
          ON s.id = v.service_id
        WHERE v.id = $1
          AND v.active = true
        LIMIT 1
        `,
        [String(chosenOption.id)]
      );

      if (chosenRow) {
        const baseName = String(chosenRow.service_name || "").trim();
        const variantName = String(chosenRow.variant_name || "").trim();
        const priceNum =
          chosenRow.price === null ||
          chosenRow.price === undefined ||
          chosenRow.price === ""
            ? null
            : Number(chosenRow.price);

        const currency = String(chosenRow.currency || "USD").trim();
        const link =
          chosenRow.variant_url
            ? String(chosenRow.variant_url).trim()
            : chosenRow.service_url
            ? String(chosenRow.service_url).trim()
            : null;

        let priceText =
          input.idiomaDestino === "en"
            ? "price available"
            : "precio disponible";

        if (Number.isFinite(priceNum)) {
          priceText =
            currency === "USD"
              ? `$${priceNum!.toFixed(2)}`
              : `${priceNum!.toFixed(2)} ${currency}`;
        }

        const reply =
          input.idiomaDestino === "en"
            ? `Perfect. The price for ${baseName} — ${variantName} is ${priceText}.${link ? `\n\nHere’s the link:\n${link}` : ""}`
            : `Perfecto. El precio de ${baseName} — ${variantName} es ${priceText}.${link ? `\n\nAquí tienes el link:\n${link}` : ""}`;

        console.log("[VARIANT_SECOND_TURN][PRICE_SELECTION]", {
          userInput: input.userInput,
          pickedIndex: numericSelectionIndex,
          chosenVariantId: chosenRow.id,
          chosenVariantName: variantName,
          price: chosenRow.price,
          targetVariantId: targetVariantId || null,
        });

        return {
          handled: true,
          reply,
          source: "price_fastpath_db",
          intent: "precio",
          ctxPatch: {
            expectingVariant: false,
            expectedVariantIntent: null,
            lastResolvedIntent: "price_or_plan",

            selectedServiceId: serviceId,

            last_service_id: serviceId,
            last_service_name: baseName || null,
            last_service_at: Date.now(),

            last_variant_id: String(chosenRow.id || ""),
            last_variant_name: variantName || null,
            last_variant_url: link || null,
            last_variant_at: Date.now(),

            last_price_option_label: variantName || null,
            last_price_option_at: Date.now(),

            last_bot_action: "answered_price_variant",
            last_bot_action_at: Date.now(),
          } as any,
        };
      }
    }
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

  if (!variants.length) {
    return {
      handled: false,
      ctxPatch: {
        expectingVariant: false,
        selectedServiceId: null,
      } as any,
    };
  }

  let chosen: any = null;

  if (targetVariantId) {
    chosen =
      variants.find(
        (v: any) => String(v.id || "") === String(targetVariantId)
      ) || null;
  }

  if (!chosen && numericSelectionIndex !== null) {
    const idx = numericSelectionIndex - 1;
    if (idx >= 0 && idx < variants.length) {
      chosen = variants[idx];
    }
  }

  if (!chosen) {
    const retryMsg =
      input.idiomaDestino === "en"
        ? "I’m not fully sure which option you want 🤔. Tell me the number of the option."
        : "No terminé de entender cuál opción te interesa 🤔. Dime el número de la opción.";

    return {
      handled: true,
      reply: retryMsg,
      source: "service_list_db",
      intent: input.intentOut || "info_servicio",
    };
  }

  const {
    rows: [service],
  } = await input.pool.query<any>(
    `
    SELECT
      name,
      description,
      service_url
    FROM services
    WHERE id = $1
    `,
    [serviceId]
  );

  const descSource = String(
    chosen.description || service?.description || ""
  ).trim();

  const link: string | null = chosen.variant_url
    ? String(chosen.variant_url).trim()
    : service?.service_url
    ? String(service.service_url).trim()
    : null;

  const baseName = String(service?.name || "").trim();
  const variantName = String(chosen.variant_name || "").trim();

  const title =
    baseName && variantName
      ? `${baseName} — ${variantName}`
      : baseName || variantName || "";

  const bulletLines = splitLines(descSource).map((line) => `• ${line}`);
  const bullets = bulletLines.join("\n");

  const extraContext = [
    "VARIANTE_DB_RESUELTA:",
    `- service_name: ${baseName}`,
    `- variant_name: ${variantName}`,
    `- detail_text: ${descSource || ""}`,
    `- direct_link: ${link || ""}`,
    `- source_of_truth: database`,
    "",
    "REGLAS_CRITICAS_DEL_TURNO:",
    "- Debes responder usando EXCLUSIVAMENTE los datos de VARIANTE_DB_RESUELTA.",
    "- NO puedes inventar beneficios, condiciones, precios o detalles que no estén explícitamente presentes en detail_text.",
    "- NO puedes mezclar esta variante con otras variantes, planes o servicios.",
    "- Debes conservar el contenido importante de detail_text; NO lo resumas a una sola frase genérica si detail_text contiene varios puntos relevantes.",
    "- Si detail_text contiene múltiples líneas o puntos, preséntalos de forma clara en formato chat.",
    "- Si direct_link existe, DEBES incluirlo textualmente al final de la respuesta.",
    "- Mantén la respuesta natural y adecuada al canal, pero sin perder información importante.",
    "- Cierra con una sola frase suave y breve.",
  ].join("\n");

  console.log("[FASTPATH-INCLUDES][LLM_RENDER] variant_second_turn", {
    userInput: input.userInput,
    serviceId,
    baseName,
    variantName,
    hasLink: !!link,
    targetVariantId: targetVariantId || null,
    numericSelectionIndex,
  });

  const aiVariantReply = await input.answerWithPromptBase({
    tenantId: input.tenantId,
    promptBase: input.promptBase,
    userInput: input.userInput,
    history: [],
    idiomaDestino: input.idiomaDestino,
    canal: input.canal,
    maxLines: 20,
    fallbackText:
      input.idiomaDestino === "en"
        ? `${title ? `${title}` : ""}${bullets ? `\n\n${bullets}` : ""}${link ? `\n\nHere you can see more details:\n${link}` : ""}`
        : `${title ? `${title}` : ""}${bullets ? `\n\n${bullets}` : ""}${link ? `\n\nAquí puedes ver más detalles:\n${link}` : ""}`,
    extraContext,
  });

  let finalReply = String(aiVariantReply.text || "").trim();

  if (link && !finalReply.includes(link)) {
    finalReply +=
      input.idiomaDestino === "en"
        ? `\n\nHere you can see more details:\n${link}`
        : `\n\nAquí puedes ver más detalles:\n${link}`;
  }

  const detailLines = splitLines(descSource);

  const finalReplyLineCount = splitLines(finalReply).length;

  const looksTooShort =
    detailLines.length >= 3 && finalReplyLineCount <= 4;

  if (looksTooShort && bullets) {
    finalReply =
      input.idiomaDestino === "en"
        ? `${title ? `${title}` : ""}\n\n${bullets}${link ? `\n\nHere you can see more details:\n${link}` : ""}`
        : `${title ? `${title}` : ""}\n\n${bullets}${link ? `\n\nAquí puedes ver más detalles:\n${link}` : ""}`;
  }

  console.log("[VARIANT_SECOND_TURN][CHOSEN]", {
    userInput: input.userInput,
    serviceId,
    chosenVariantId: chosen?.id,
    chosenVariantName: chosen?.variant_name,
    targetVariantId: targetVariantId || null,
    numericSelectionIndex,
  });

  return {
    handled: true,
    reply: finalReply,
    source: "service_list_db",
    intent: input.intentOut || "info_servicio",
    ctxPatch: {
      expectingVariant: false,
      expectedVariantIntent: null,

      lastResolvedIntent: "price_or_plan",

      selectedServiceId: serviceId,

      last_service_id: serviceId,
      last_service_name: baseName || null,
      last_service_at: Date.now(),

      last_variant_id: String(chosen.id || ""),
      last_variant_name: variantName || null,
      last_variant_url: link || null,
      last_variant_at: Date.now(),

      last_price_option_label: variantName || null,
      last_price_option_at: Date.now(),
    } as any,
  };
}