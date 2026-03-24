import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";

export type HandleSingleServiceCatalogInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
  routeIntent: string;
  catalogRoutingSignal: any;
  catalogReferenceClassification?: any;

  rows: any[];

  answerWithPromptBase: (input: any) => Promise<{ text: string }>;
  promptBase: string;
  canal: any;
  catalogRouteIntent?: string | null;
};

export async function handleSingleServiceCatalog(
  input: HandleSingleServiceCatalogInput
): Promise<FastpathResult> {
  const {
    referenceKind,
    targetServiceId: structuredTargetServiceId,
    targetVariantId,
    targetFamilyKey,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
    catalogRouteIntent: input.catalogRouteIntent,
  });

    const shouldSkipSinglePriceTargetResolution =
      input.routeIntent === "catalog_overview";

    const ellipticPriceFollowup =
      input.catalogRoutingSignal.shouldRouteCatalog &&
      (
        referenceKind === "referential_followup" ||
        input.catalogRoutingSignal.routeIntent === "catalog_alternatives" ||
        input.catalogRoutingSignal.routeIntent === "catalog_schedule" ||
        input.catalogRoutingSignal.routeIntent === "catalog_price" ||
        input.catalogReferenceClassification?.intent === "includes"
      );

    const ctxServiceId =
      String(input.convoCtx?.last_service_id || "").trim() ||
      String(input.convoCtx?.selectedServiceId || "").trim();

    const ctxServiceName =
      String(input.convoCtx?.last_service_name || "").trim();

    const singleHit =
      shouldSkipSinglePriceTargetResolution
        ? null
        : shouldResolveFromStructuredTarget
        ? {
            id: String(structuredTargetServiceId || "").trim(),
            name: String(
              input.catalogReferenceClassification?.targetServiceName ||
              ctxServiceName ||
              ""
            ).trim(),
          }
        : ellipticPriceFollowup && ctxServiceId
        ? {
            id: ctxServiceId,
            name: ctxServiceName,
          }
        : null;

  if (shouldSkipSinglePriceTargetResolution) {
    console.log("[PRICE][single] skipped_by_catalog_reference_classification", {
      userInput: input.userInput,
      catalogReferenceKind: input.catalogReferenceClassification?.kind ?? "none",
    });
  }

  console.log("[PRICE][single] structured resolve output", {
    userInput: input.userInput,
    ellipticPriceFollowup,
    referenceKind,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
    structuredTargetServiceId,
    targetVariantId,
    targetFamilyKey,
    singleHit,
    ctxLastService: input.convoCtx?.last_service_id
        ? {
            id: input.convoCtx.last_service_id,
            name: input.convoCtx.last_service_name || null,
        }
        : null,
    });

  if (singleHit?.id) {
    const targetServiceId = String(singleHit.id || "").trim();
    const targetServiceName = String(singleHit.name || "").trim();

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
      [targetServiceId]
    );

    console.log("[PRICE][single] variants fetched", {
      targetServiceId,
      targetServiceName,
      variants: variants.map((v: any) => ({
        id: v.id,
        variant_name: v.variant_name,
        price: v.price,
        currency: v.currency,
      })),
    });

    const pricedVariants = variants.filter((v: any) => {
      const n = Number(v.price);
      return Number.isFinite(n) && n > 0;
    });

    let chosenVariant: any = null;

    if (pricedVariants.length > 0) {
      const storedVariantOptions = Array.isArray((input.convoCtx as any)?.last_variant_options)
        ? (input.convoCtx as any).last_variant_options
        : [];

      const isAwaitingPriceVariantSelection =
        input.convoCtx.expectedVariantIntent === "price_or_plan" &&
        Boolean((input.convoCtx as any)?.expectingVariant) &&
        storedVariantOptions.length > 0;

      if (targetVariantId) {
        chosenVariant =
          pricedVariants.find(
            (v: any) => String(v.id) === String(targetVariantId)
          ) || null;

        console.log("[PRICE][single][STRUCTURED_VARIANT_SELECTION]", {
          userInput: input.userInput,
          targetVariantId,
          chosenVariant: chosenVariant
            ? {
                id: chosenVariant.id,
                variant_name: chosenVariant.variant_name,
                price: chosenVariant.price,
              }
            : null,
        });
      }

      if (!chosenVariant && isAwaitingPriceVariantSelection && targetVariantId) {
        const pickedFromContext =
          storedVariantOptions.find(
            (opt: any) => String(opt.id || "") === String(targetVariantId)
          ) || null;

        if (pickedFromContext?.id) {
          chosenVariant =
            pricedVariants.find(
              (v: any) => String(v.id) === String(pickedFromContext.id)
            ) || null;
        }

        console.log("[PRICE][single][STRUCTURED_VARIANT_SELECTION_FROM_CONTEXT]", {
          userInput: input.userInput,
          targetVariantId,
          pickedFromContext,
          chosenVariant: chosenVariant
            ? {
                id: chosenVariant.id,
                variant_name: chosenVariant.variant_name,
                price: chosenVariant.price,
              }
            : null,
        });
      }
    }

    console.log("[PRICE][single] final reply inputs", {
      targetServiceId,
      targetServiceName,
      variantsCount: variants.length,
      pricedVariantsCount: pricedVariants.length,
      chosenVariant: chosenVariant
        ? {
            id: chosenVariant.id,
            variant_name: chosenVariant.variant_name,
            price: chosenVariant.price,
            currency: chosenVariant.currency,
          }
        : null,
    });

    // ✅ Si resolvió variante concreta, responder con answerWithPromptBase
    // usando precio + includes reales desde DB, sin link automático
    // y con guardrail para no alterar la fuente de verdad.
    if (chosenVariant) {
      console.log("[PRICE][chosenVariant]", {
        userInput: input.userInput,
        targetServiceId,
        targetServiceName,
        chosenVariant: {
          id: chosenVariant?.id,
          variant_name: chosenVariant?.variant_name,
          price: chosenVariant?.price,
          variant_url: chosenVariant?.variant_url,
        },
        allVariants: pricedVariants.map((v: any) => ({
          id: v.id,
          variant_name: v.variant_name,
          price: v.price,
        })),
      });

      const priceNum =
        chosenVariant.price === null ||
        chosenVariant.price === undefined ||
        chosenVariant.price === ""
          ? null
          : Number(chosenVariant.price);

      const baseName = targetServiceName || "";
      const variantName = String(chosenVariant.variant_name || "").trim();
      const resolvedCurrency = String(chosenVariant.currency || "USD");

      const {
        rows: [serviceBase],
      } = await input.pool.query<any>(
        `
        SELECT description
        FROM services
        WHERE id = $1
        LIMIT 1
        `,
        [targetServiceId]
      );

      const serviceDescription = String(
        chosenVariant.description || serviceBase?.description || ""
      ).trim();

      let priceText =
        input.idiomaDestino === "en" ? "price available" : "precio disponible";

      if (Number.isFinite(priceNum)) {
        priceText =
          resolvedCurrency === "USD"
            ? `$${priceNum!.toFixed(2)}`
            : `${priceNum!.toFixed(2)} ${resolvedCurrency}`;
      }

      const detailLines = serviceDescription
        ? serviceDescription
            .split(/\r?\n/)
            .map((l: string) => l.trim())
            .filter((l: string) => l.length > 0)
        : [];

      const bulletsText = detailLines.length
        ? detailLines.map((l: string) => `• ${l}`).join("\n")
        : "";

      const canonicalBody =
        input.idiomaDestino === "en"
          ? `${baseName} — ${variantName}\nPrice: ${priceText}${
              bulletsText ? `\n\nIncludes:\n${bulletsText}` : ""
            }`
          : `${baseName} — ${variantName}\nPrecio: ${priceText}${
              bulletsText ? `\n\nIncluye:\n${bulletsText}` : ""
            }`;

      const wrapperFallback =
        input.idiomaDestino === "en"
          ? {
              intro: "Perfect 😊",
              outro: "If you need anything else, just let me know 😊",
            }
          : {
              intro: "Perfecto 😊",
              outro: "Si necesitas algo más, avísame 😊",
            };

      const wrapperInstruction =
        input.idiomaDestino === "en"
          ? [
              "You are rendering a WhatsApp sales reply.",
              "IMPORTANT: You are NOT allowed to rewrite the canonical body.",
              "You may ONLY produce:",
              "- a very short natural intro",
              "- a very short natural outro",
              "Do NOT change product/service facts.",
              "Do NOT restate or paraphrase the body.",
              "Do NOT add prices, conditions, benefits, links, durations, or names not already resolved.",
              'Return valid JSON with exactly this shape: {"intro":"...","outro":"..."}',
            ].join("\n")
          : [
              "Estás renderizando una respuesta comercial para WhatsApp.",
              "IMPORTANTE: NO puedes reescribir el cuerpo canónico.",
              "Solo puedes producir:",
              "- un intro muy breve y natural",
              "- un cierre muy breve y natural",
              "NO cambies hechos del servicio o producto.",
              "NO repitas ni parafrasees el cuerpo.",
              "NO agregues precios, condiciones, beneficios, links, duraciones ni nombres no resueltos.",
              'Devuelve JSON válido con esta forma exacta: {"intro":"...","outro":"..."}',
            ].join("\n");

      const wrapperContext = [
        "CANONICAL_BODY_START",
        canonicalBody,
        "CANONICAL_BODY_END",
        "",
        "REGLAS_CRITICAS:",
        "- El cuerpo canónico se insertará después por el sistema.",
        "- No debes reescribirlo.",
        "- intro: máximo 1 línea.",
        "- outro: máximo 1 línea.",
        "- El intro debe sonar natural, cálido y breve.",
        "- El cierre debe sonar natural y comercial, sin sonar robótico.",
        "- No hagas preguntas obligatorias de sí/no.",
        "- No menciones links en intro ni outro.",
        "- No uses saludo tipo 'Hola' si la conversación ya está en curso.",
        "- No digas 'te recomiendo' si el usuario ya eligió una opción concreta.",
        "- El intro debe funcionar como confirmación breve de la selección, no como nueva recomendación.",
      ].join("\n");

      console.log("[PRICE][single][LLM_RENDER_WRAPPER_ONLY]", {
        targetServiceId,
        targetServiceName,
        variantName,
        priceNum,
        resolvedCurrency,
        hasDetailText: !!serviceDescription,
      });

      const wrapperReply = await input.answerWithPromptBase({
        tenantId: input.tenantId,
        promptBase: `${input.promptBase}\n\n${wrapperInstruction}`,
        userInput:
          input.idiomaDestino === "en"
            ? "Render only a short confirmation intro and a soft commercial closing."
            : "Renderiza solo un intro breve de confirmación y un cierre comercial suave.",
        history: [],
        idiomaDestino: input.idiomaDestino,
        canal: input.canal,
        maxLines: 4,
        fallbackText: JSON.stringify(wrapperFallback),
        extraContext: wrapperContext,
      });

      let intro = wrapperFallback.intro;
      let outro = wrapperFallback.outro;

      try {
        const parsed = JSON.parse(String(wrapperReply.text || "").trim());

        if (parsed && typeof parsed === "object") {
          const parsedIntro = String(parsed.intro || "").trim();
          const parsedOutro = String(parsed.outro || "").trim();

          if (parsedIntro) intro = parsedIntro;
          if (parsedOutro) outro = parsedOutro;
        }
      } catch {
        // fallback silencioso
      }

      const finalReply = [intro, canonicalBody, outro]
        .filter((x) => String(x || "").trim().length > 0)
        .join("\n\n");

      console.log("[PRICE][single][WRAPPER_RESULT]", {
        intro,
        outro,
        canonicalBodyPreview: canonicalBody.slice(0, 220),
        finalReplyPreview: finalReply.slice(0, 260),
      });

      return {
        handled: true,
        reply: finalReply,
        source: "price_fastpath_db_llm_render",
        intent: "precio",
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: baseName || null,
          last_service_at: Date.now(),

          last_variant_id: String(chosenVariant.id || ""),
          last_variant_name: variantName || null,
          last_variant_url: null,
          last_variant_at: Date.now(),

          last_price_option_label: variantName || null,
          last_price_option_at: Date.now(),

          expectedVariantIntent: null,
          lastResolvedIntent: "price_or_plan",
        } as any,
      };
    }

    // ✅ Si hay varias variantes con precio y el usuario NO eligió una,
    // listar variantes para que seleccione en vez de resumir por rango.
    if (pricedVariants.length > 1 && !chosenVariant) {
      console.log("[PRICE][single] multiple priced variants -> list for selection", {
        targetServiceId,
        targetServiceName,
        pricedVariants: pricedVariants.map((v: any, idx: number) => ({
          index: idx + 1,
          id: v.id,
          variant_name: v.variant_name,
          price: v.price,
          currency: v.currency,
          variant_url: v.variant_url,
        })),
      });

      const lines = pricedVariants.map((v: any, idx: number) => {
        const rawPrice =
          v.price === null || v.price === undefined || v.price === ""
            ? NaN
            : Number(v.price);

        const currency = String(v.currency || "USD").trim();
        const variantName = String(v.variant_name || "").trim();

        let priceText =
          input.idiomaDestino === "en" ? "price available" : "precio disponible";

        if (Number.isFinite(rawPrice)) {
          if (currency === "USD") {
            priceText = `$${rawPrice.toFixed(2)}`;
          } else {
            priceText = `${rawPrice.toFixed(2)} ${currency}`;
          }
        }

        return `• ${idx + 1}) ${variantName}: ${priceText}`;
      });

      const header =
        input.idiomaDestino === "en"
          ? `${targetServiceName} has these options:`
          : `${targetServiceName} tiene estas opciones:`;

      const ask =
        input.idiomaDestino === "en"
          ? "Which option are you interested in? You can reply with the number or the name."
          : "¿Cuál opción te interesa? Puedes responder con el número o el nombre.";

      return {
        handled: true,
        reply: `${header}\n\n${lines.join("\n")}\n\n${ask}`,
        source: "price_disambiguation_db",
        intent: "precio",
        ctxPatch: {
          selectedServiceId: targetServiceId,
          expectingVariant: true,
          expectedVariantIntent: "price_or_plan",

          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),

          last_variant_id: null,
          last_variant_name: null,
          last_variant_url: null,
          last_variant_at: null,

          last_variant_options: pricedVariants.map((v: any, idx: number) => ({
            index: idx + 1,
            id: String(v.id || ""),
            name: String(v.variant_name || "").trim(),
            url: v.variant_url ? String(v.variant_url).trim() : null,
            price:
              v.price === null || v.price === undefined || v.price === ""
                ? null
                : Number(v.price),
            currency: String(v.currency || "USD").trim(),
          })),
          last_variant_options_at: Date.now(),

          last_price_option_label: null,
          last_price_option_at: null,

          last_bot_action: "asked_price_variant",
          last_bot_action_at: Date.now(),
        } as any,
      };
    }

    // ✅ Si resolvió servicio, pero no variante exacta, responder natural usando DB + answerWithPromptBase
    const matchedRow = input.rows.find(
      (r) => String(r.service_id || "") === targetServiceId
    );

    const hasServicePriceRow = !!matchedRow;

    if (pricedVariants.length === 0 && !hasServicePriceRow) {
      console.log("[PRICE][single][LLM_RENDER] no_price_policy_fallback", {
        targetServiceId,
        targetServiceName,
      });

      const extraContext = [
        "PRECIO_DB_RESUELTO:",
        `- service_name: ${targetServiceName}`,
        `- pricing_mode: no_explicit_price`,
        `- source_of_truth: database`,
        "",
        "REGLAS_CRITICAS_DEL_TURNO:",
        "- El servicio fue resuelto correctamente desde DB.",
        "- Este servicio NO tiene precio explícito en variantes ni en price_base.",
        "- NO puedes inventar montos, rangos, estimados, visitas, evaluaciones ni cotizaciones si no están explícitamente configurados.",
        "- NO puedes cambiar a otros servicios del catálogo.",
        "- Debes responder SOLO sobre este servicio.",
        "- Si no hay precio disponible, dilo de forma natural y breve sin asumir la causa.",
        "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
        "",
        "CONTINUIDAD_CONVERSACIONAL:",
        "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
        "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
        "- Evita respuestas que solo informen el precio sin invitar a continuar.",
      ].join("\n");

      const aiNoPricePolicyReply = await input.answerWithPromptBase({
        tenantId: input.tenantId,
        promptBase: input.promptBase,
        userInput: input.userInput,
        history: [],
        idiomaDestino: input.idiomaDestino,
        canal: input.canal,
        maxLines: 6,
        fallbackText:
          input.idiomaDestino === "en"
            ? `We do offer ${targetServiceName}, but I don't currently have a price available for that service.`
            : `Sí ofrecemos ${targetServiceName}, pero ahora mismo no tengo un precio disponible para ese servicio.`,
        extraContext,
      });

      return {
        handled: true,
        reply: aiNoPricePolicyReply.text,
        source: "price_fastpath_db_no_price_llm_render",
        intent: "precio",
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),
          lastResolvedIntent: "price_or_plan",
          expectedVariantIntent: null,
        } as any,
      };
    }

    if (matchedRow) {
      const min = matchedRow.min_price === null ? null : Number(matchedRow.min_price);
      const max = matchedRow.max_price === null ? null : Number(matchedRow.max_price);

      const hasExplicitServicePrice =
        Number.isFinite(min) && Number.isFinite(max);

      if (!hasExplicitServicePrice) {
        console.log("[PRICE][single][LLM_RENDER] no_explicit_price", {
          targetServiceId,
          targetServiceName,
        });

        const extraContext = [
          "PRECIO_DB_RESUELTO:",
          `- service_name: ${targetServiceName}`,
          `- pricing_mode: no_explicit_price`,
          `- source_of_truth: database`,
          "",
          "REGLAS_CRITICAS_DEL_TURNO:",
          "- El servicio sí existe en DB.",
          "- En este turno NO existe un precio explícito utilizable para este servicio.",
          "- NO puedes inventar montos, rangos ni precios aproximados.",
          "- NO puedes mencionar otros servicios como alternativa de precio, a menos que el usuario los pida.",
          "- Responde de forma natural, útil y comercial, manteniéndote en el servicio resuelto.",
          "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
          "",
          "CONTINUIDAD_CONVERSACIONAL:",
          "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
          "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
          "- Evita respuestas que solo informen el precio sin invitar a continuar.",
        ].join("\n");

        const aiNoPriceReply = await input.answerWithPromptBase({
          tenantId: input.tenantId,
          promptBase: input.promptBase,
          userInput: input.userInput,
          history: [],
          idiomaDestino: input.idiomaDestino,
          canal: input.canal,
          maxLines: 6,
          fallbackText:
            input.idiomaDestino === "en"
              ? `We do offer ${targetServiceName}, but I don't currently have an explicit price configured for that service.`
              : `Sí ofrecemos ${targetServiceName}, pero ahora mismo no tengo un precio explícito configurado para ese servicio.`,
          extraContext,
        });

        return {
          handled: true,
          reply: aiNoPriceReply.text,
          source: "price_fastpath_db_no_price_llm_render",
          intent: "precio",
          ctxPatch: {
            last_service_id: targetServiceId,
            last_service_name: targetServiceName || null,
            last_service_at: Date.now(),
            lastResolvedIntent: "price_or_plan",
            expectedVariantIntent: null,
          } as any,
        };
      }

      const priceText =
        min === max
          ? `$${min!.toFixed(2)}`
          : `${input.idiomaDestino === "en" ? "from" : "desde"} $${min!.toFixed(2)}`;

      console.log("[PRICE][single][LLM_RENDER] service_price", {
        targetServiceId,
        targetServiceName,
        min,
        max,
      });

      const extraContext = [
        "PRECIO_DB_RESUELTO:",
        `- service_name: ${targetServiceName}`,
        `- pricing_mode: ${min === max ? "fixed" : "from_price"}`,
        `- min_price: ${min ?? ""}`,
        `- max_price: ${max ?? ""}`,
        `- source_of_truth: database`,
        "",
        "REGLAS_CRITICAS_DEL_TURNO:",
        "- Debes responder usando EXCLUSIVAMENTE estos datos resueltos desde DB.",
        "- NO puedes inventar otros precios, rangos, variantes ni servicios alternativos.",
        "- NO puedes mezclar este servicio con otros del catálogo.",
        "- Si mencionas el precio, debe corresponder únicamente al servicio resuelto.",
        "- Redacta de forma natural, humana, breve y comercial para WhatsApp.",
        "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
        "",
        "CONTINUIDAD_CONVERSACIONAL:",
        "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
        "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
        "- Evita respuestas que solo informen el precio sin invitar a continuar.",
      ].join("\n");

      const aiServicePriceReply = await input.answerWithPromptBase({
        tenantId: input.tenantId,
        promptBase: input.promptBase,
        userInput: input.userInput,
        history: [],
        idiomaDestino: input.idiomaDestino,
        canal: input.canal,
        maxLines: 6,
        fallbackText:
          input.idiomaDestino === "en"
            ? `${targetServiceName} costs ${priceText}.`
            : `${targetServiceName} cuesta ${priceText}.`,
        extraContext,
      });

      return {
        handled: true,
        reply: aiServicePriceReply.text,
        source: "price_fastpath_db_llm_render",
        intent: "precio",
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),
          lastResolvedIntent: "price_or_plan",
          expectedVariantIntent: null,
        } as any,
      };
    }
  }

  return {
    handled: false,
  };
}