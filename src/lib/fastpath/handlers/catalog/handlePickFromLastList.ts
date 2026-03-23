//src/lib/fastpath/handlers/catalog/handlePickFromLastList.ts

type HandlePickFromLastListInput = {
  userInput: string;
  idiomaDestino: "es" | "en" | string;
  convoCtx: any;
  tenantId: string;
  pool: any;

  detectedIntent?: string | null;
  catalogReferenceClassification?: any;
  intentOut?: string | null;

  normalizeText: (input: string) => string;
  bestNameMatch: (input: string, list: any[]) => any;
  getServiceDetailsText: (
    tenantId: string,
    serviceId: string,
    userInput: string
  ) => Promise<any>;
  resolveBestLinkForService: (args: {
    pool: any;
    tenantId: string;
    serviceId: string;
    userText: string;
  }) => Promise<any>;
};

type HandlePickFromLastListResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string;
  ctxPatch?: any;
};

export async function handlePickFromLastList(
  input: HandlePickFromLastListInput
): Promise<HandlePickFromLastListResult> {
  const {
    userInput,
    idiomaDestino,
    convoCtx,
    tenantId,
    pool,
    detectedIntent,
    catalogReferenceClassification,
    intentOut,
    normalizeText,
    bestNameMatch,
    getServiceDetailsText,
    resolveBestLinkForService,
  } = input;

  const ttlMs = 5 * 60 * 1000;

  const planList = Array.isArray(convoCtx?.last_plan_list) ? convoCtx.last_plan_list : [];
  const planAtRaw = convoCtx?.last_plan_list_at;
  const planAt = Number(planAtRaw);
  const planAtOk = Number.isFinite(planAt) && planAt > 0;
  const planFresh = planList.length > 0 && (!planAtOk || Date.now() - planAt <= ttlMs);

  const pkgList = Array.isArray(convoCtx?.last_package_list) ? convoCtx.last_package_list : [];
  const pkgAtRaw = convoCtx?.last_package_list_at;
  const pkgAt = Number(pkgAtRaw);
  const pkgAtOk = Number.isFinite(pkgAt) && pkgAt > 0;
  const pkgFresh = pkgList.length > 0 && (!pkgAtOk || Date.now() - pkgAt <= ttlMs);

  const kind = (convoCtx?.last_list_kind as any) || null;
  const kindAtRaw = convoCtx?.last_list_kind_at;
  const kindAt = Number(kindAtRaw);
  const kindAtOk = Number.isFinite(kindAt) && kindAt > 0;
  const kindFresh = Boolean(kind) && (!kindAtOk || Date.now() - kindAt <= ttlMs);

  const healPatch: Record<string, any> = {};

  if (planList.length > 0 && !planAtOk) healPatch.last_plan_list_at = Date.now();
  if (pkgList.length > 0 && !pkgAtOk) healPatch.last_package_list_at = Date.now();
  if (kind && !kindAtOk) healPatch.last_list_kind_at = Date.now();

  if (!(planFresh || pkgFresh)) {
    return { handled: false };
  }

  const classifiedIntentNorm = String(
    catalogReferenceClassification?.intent || ""
  ).trim().toLowerCase();

  const detectedIntentNorm = String(detectedIntent || "").trim().toLowerCase();

  const isTrialLikeTurn =
    detectedIntentNorm === "info_servicio" &&
    classifiedIntentNorm === "price_or_plan" &&
    !catalogReferenceClassification?.targetServiceId &&
    !convoCtx?.last_service_id &&
    !convoCtx?.selectedServiceId;

  if (isTrialLikeTurn) {
    console.log("🧪 PICK SKIP — structured trial/demo-like turn, dejar a otras reglas manejarlo");
    return { handled: false };
  }

  const idx = (() => {
    const t = String(userInput || "").trim();
    const m = t.match(/^([1-9])$/);
    return m ? Number(m[1]) : null;
  })();

  const msgNorm = normalizeText(userInput);

  const mentionsPlanFromList =
    planFresh &&
    planList.some((p: any) => {
      const name = String(p?.name ?? p?.label ?? "").trim();
      if (!name) return false;
      const nameNorm = normalizeText(name);
      return !!nameNorm && msgNorm.includes(nameNorm);
    });

  const mentionsPackageFromList =
    pkgFresh &&
    pkgList.some((p: any) => {
      const name = String(p?.name ?? p?.label ?? "").trim();
      if (!name) return false;
      const nameNorm = normalizeText(name);
      return !!nameNorm && msgNorm.includes(nameNorm);
    });

  const candidateFromPlans = planFresh ? bestNameMatch(userInput, planList as any) : null;
  const candidateFromPackages = pkgFresh ? bestNameMatch(userInput, pkgList as any) : null;

  if (
    !candidateFromPlans &&
    !candidateFromPackages &&
    !mentionsPlanFromList &&
    !mentionsPackageFromList &&
    idx == null
  ) {
    console.log("🧪 PICK SKIP — no numeric choice or fuzzy match in msg");
    return { handled: false };
  }

  const tryPick = (
    list: Array<{ id: string; name: string; url: string | null }>,
    kind: "plan" | "package"
  ) => {
    let picked: { id: string; name: string; url: string | null } | null = null;

    if (idx != null) {
      const i = idx - 1;
      if (i >= 0 && i < list.length) picked = list[i];
    }

    if (!picked) picked = bestNameMatch(userInput, list as any) as any;
    return picked ? { ...picked, kind } : null;
  };

  let picked: {
    id: string;
    name: string;
    url: string | null;
    kind: "plan" | "package";
  } | null = null;

  if (kindFresh && kind === "package") {
    if (pkgFresh) picked = tryPick(pkgList, "package");
    if (!picked && planFresh) picked = tryPick(planList, "plan");
  } else {
    if (planFresh) picked = tryPick(planList, "plan");
    if (!picked && pkgFresh) picked = tryPick(pkgList, "package");
  }

  if (!picked) {
    return { handled: false };
  }

  const rawPickedId = String(picked.id || "");
  const parts = rawPickedId.split("::");
  const pickedServiceId = parts[0] || rawPickedId;
  const pickedOptionLabel = parts.length > 1 ? parts.slice(1).join("::") : null;

  const basePatch: Record<string, any> = {
    last_selected_kind: picked.kind,
    last_selected_id: picked.id,
    last_selected_name: picked.name,
    last_selected_at: Date.now(),

    last_service_id: pickedServiceId,
    last_service_name: picked.name,
    last_service_at: Date.now(),

    last_price_option_label: pickedOptionLabel,
    last_price_option_at: Date.now(),
  };

  const pendingLinkOptions = Array.isArray(convoCtx?.pending_link_options)
    ? convoCtx.pending_link_options
    : [];

  const pendingLinkLookupActive =
    Boolean(convoCtx?.pending_link_lookup) && pendingLinkOptions.length > 0;

  const numericChoice =
    idx != null && idx >= 1 && idx <= pendingLinkOptions.length
      ? pendingLinkOptions[idx - 1]
      : null;

  const namedChoice =
    !numericChoice && pendingLinkLookupActive
      ? (bestNameMatch(userInput, pendingLinkOptions as any) as any)
      : null;

  const directPendingChoice = numericChoice || namedChoice;

  let finalUrl: string | null =
    directPendingChoice?.url
      ? String(directPendingChoice.url).trim()
      : picked.url
      ? String(picked.url).trim()
      : null;

  if (directPendingChoice?.url) {
    const d = await getServiceDetailsText(tenantId, pickedServiceId, userInput).catch(
      () => null
    );

    const baseName =
      String(convoCtx?.last_service_name || "") || String(picked.name || "");
    const title = d?.titleSuffix ? `${baseName} — ${d.titleSuffix}` : baseName;
    const infoText = d?.text ? String(d.text).trim() : "";

    const reply =
      idiomaDestino === "en"
        ? `${title}${infoText ? `\n\n${infoText}` : ""}\n\nHere’s the link:\n${finalUrl}`
        : `${title}${infoText ? `\n\n${infoText}` : ""}\n\nAquí está el link:\n${finalUrl}`;

    return {
      handled: true,
      reply,
      source: "service_list_db",
      intent: intentOut || "seleccion",
      ctxPatch: {
        ...basePatch,
        pending_link_lookup: undefined,
        pending_link_at: undefined,
        pending_link_options: undefined,
        last_price_option_label: String(directPendingChoice.label || "").trim() || null,
        last_price_option_at: Date.now(),
        last_bot_action: "sent_link_option",
        last_bot_action_at: Date.now(),
      },
    };
  }

  if (!finalUrl) {
    const linkPick = await resolveBestLinkForService({
      pool,
      tenantId,
      serviceId: pickedServiceId,
      userText: userInput,
    });

    if (linkPick.ok) {
      finalUrl = linkPick.url;
    } else if (linkPick.reason === "ambiguous") {
      const optionsList = linkPick.options
        .slice(0, 3)
        .map((o: any, i: number) => `• ${i + 1}) ${String(o.label || "").trim()}`)
        .join("\n");

      const q =
        idiomaDestino === "en"
          ? `Just to make sure 😊 are you referring to:\n\n${optionsList}\n\nYou can reply with the number or the name.`
          : `Solo para asegurarme 😊 ¿te refieres a:\n\n${optionsList}\n\nPuedes responder con el número o el nombre.`;

      return {
        handled: true,
        reply: q,
        source: "service_list_db",
        intent: intentOut || "seleccion",
        ctxPatch: {
          ...healPatch,
          ...basePatch,
          pending_link_lookup: true,
          pending_link_at: Date.now(),
          pending_link_options: linkPick.options,
          last_bot_action: "asked_link_option",
          last_bot_action_at: Date.now(),
        },
      };
    }
  }

  const d = await getServiceDetailsText(tenantId, pickedServiceId, userInput).catch(
    () => null
  );

  const baseName = String(convoCtx?.last_service_name || "") || String(picked.name || "");
  const title = d?.titleSuffix ? `${baseName} — ${d.titleSuffix}` : baseName;
  const infoText = d?.text ? String(d.text).trim() : "";

  if (!finalUrl) {
    const linkPick2 = await resolveBestLinkForService({
      pool,
      tenantId,
      serviceId: pickedServiceId,
      userText: userInput,
    }).catch(() => null);

    if (linkPick2?.ok) finalUrl = linkPick2.url;
  }

  const reply =
    idiomaDestino === "en"
      ? `${title}${infoText ? `\n\n${infoText}` : ""}${
          finalUrl ? `\n\nHere’s the link:\n${finalUrl}` : ""
        }`
      : `${title}${infoText ? `\n\n${infoText}` : ""}${
          finalUrl ? `\n\nAquí está el link:\n${finalUrl}` : ""
        }`;

  return {
    handled: true,
    reply,
    source: "service_list_db",
    intent: intentOut || "seleccion",
    ctxPatch: {
      ...basePatch,
      pending_link_lookup: undefined,
      pending_link_at: undefined,
      pending_link_options: undefined,
      last_bot_action: "sent_details",
      last_bot_action_at: Date.now(),
    },
  };
}