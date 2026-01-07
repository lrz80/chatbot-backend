import { getConversationState, setConversationState, clearConversationState } from "../lib/conversationState";
import { getMemoryValue, setMemoryValue } from "../lib/clientMemory";
import { getFlowByKey, getStepByKey } from "../lib/flowRepo";

type Canal = "whatsapp" | "facebook" | "instagram" | "sms" | "voice";

export type FlowResult = {
  reply: string | null;
  didHandle: boolean; // true si el motor respondió algo (prompt o mensaje)
};

console.log("🧠 [FlowEngine] MODULE LOADED = V1");
function pickPrompt(step: { prompt_es: string; prompt_en: string }, lang: "es" | "en") {
  return lang === "en" ? step.prompt_en : step.prompt_es;
}

function isChannelKeyword(userInputRaw: string) {
  const t = (userInputRaw || "").trim().toLowerCase();
  return (
    t === "facebook" || t === "instagram" || t === "whatsapp" ||
    t.includes("face") || t.includes("fb") || t.includes("insta") || t.includes("whats")
  );
}

// Validadores por "expected.type" (mínimos por ahora)
function validateExpected(expected: any, userInputRaw: string): { ok: boolean; value?: any } {
  const text = (userInputRaw || "").trim();

  const type = expected?.type;
  if (!type) return { ok: true, value: text }; // si no define expected, aceptamos texto

  if (type === "channel_choice") {
    const t = text.toLowerCase();
    const selected: string[] = [];

    if (t.includes("whats")) selected.push("whatsapp");
    if (t.includes("insta")) selected.push("instagram");
    if (t.includes("face") || t.includes("fb")) selected.push("facebook");
    if (t.includes("los tres") || t.includes("todos") || t.includes("all") || t.includes("three")) {
      return { ok: true, value: ["whatsapp", "facebook", "instagram"] };
    }

    // También aceptar entradas exactas
    if (["whatsapp", "facebook", "instagram"].includes(t)) return { ok: true, value: [t] };

    if (selected.length === 0) return { ok: false };
    return { ok: true, value: Array.from(new Set(selected)) };
  }

  // Tipo desconocido => tratamos como texto
  return { ok: true, value: text };
}

// Persistencia genérica de resultado (decisiones) usando rules del step.expected.persist
async function persistDecisionFromStep(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  stepKey: string;
  expected: any;
  parsedValue: any;
}) {
  const { tenantId, canal, senderId, expected, parsedValue } = params;

  // Convención: expected.persist = { key: "channels_selected" } o { key:"onboarding_completed", value:true }
  const persist = expected?.persist;

  if (!persist?.key) return;

  const valueToSave = persist.hasOwnProperty("value") ? persist.value : parsedValue;

  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: persist.key,
    value: valueToSave,
  });
}

async function getPrefilledValueFromMemory(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  step: any;
}) {
  const { tenantId, canal, senderId, step } = params;

  // Regla: si el step define expected.persist.key, usamos esa key como “dato esperado”
  const key = step?.expected?.persist?.key;
  if (!key) return { has: false, value: null, key: null };

  const val = await getMemoryValue<any>({ tenantId, canal, senderId, key });

  const has =
    val !== null &&
    val !== undefined &&
    !(typeof val === "string" && val.trim() === "") &&
    !(Array.isArray(val) && val.length === 0);

  return { has, value: val, key };
}

async function autoAdvanceUsingMemory(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  lang: "es" | "en";
  flow: any;
  state: any;
  maxHops?: number;
}) {
  const { tenantId, canal, senderId, lang, flow, state } = params;
  const maxHops = params.maxHops ?? 5;

  let currentStepKey = state.active_step;
  let ctx = state.context ?? {};

  for (let i = 0; i < maxHops; i++) {
    const step = await getStepByKey({ flowId: flow.id, stepKey: currentStepKey });
    if (!step) break;

    const prefilled = await getPrefilledValueFromMemory({
      tenantId,
      canal,
      senderId,
      step,
    });

    // Si NO hay dato prellenado, paramos: este step sí hay que preguntarlo
    if (!prefilled.has) {
      return {
        advanced: i > 0,
        stepToAsk: step,
        finalState: { ...state, active_step: currentStepKey, context: ctx },
      };
    }

    // ✅ Si hay dato prellenado, persistimos “como si el usuario lo hubiera dicho”
    await persistDecisionFromStep({
      tenantId,
      canal,
      senderId,
      stepKey: step.step_key,
      expected: step.expected,
      parsedValue: prefilled.value,
    });

    const next = step.on_success_next_step;

    // Si el flow termina, limpiamos state y salimos sin pregunta
    if (!next || next === "done") {
      await clearConversationState({ tenantId, canal, senderId });
      return {
        advanced: true,
        stepToAsk: null,
        finalState: null,
      };
    }

    // Avanzamos
    currentStepKey = next;

    await setConversationState({
      tenantId,
      canal,
      senderId,
      activeFlow: flow.flow_key,
      activeStep: currentStepKey,
      context: ctx,
    });
  }

  // Si llegamos aquí, evitamos loops infinitos: preguntamos el step actual
  const stepToAsk = await getStepByKey({ flowId: flow.id, stepKey: currentStepKey });
  return {
    advanced: true,
    stepToAsk: stepToAsk || null,
    finalState: { ...state, active_step: currentStepKey, context: ctx },
  };
}

export async function handleMessageWithFlowEngine(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  lang: "es" | "en";
  userInput: string;
}): Promise<FlowResult> {
  const { tenantId, canal, senderId, lang, userInput } = params;
  console.log("🧠 [FlowEngine] IN = V1", { tenantId, canal, senderId, userInput });

  // 1) Si hay state activo: resolver step actual
  const state = await getConversationState({ tenantId, canal, senderId });

  if (state?.active_flow && state?.active_step) {
    const flow = await getFlowByKey({ tenantId, flowKey: state.active_flow });
    if (!flow || !flow.enabled) {
      await clearConversationState({ tenantId, canal, senderId });
      return { reply: null, didHandle: false };
    }

    const step = await getStepByKey({ flowId: flow.id, stepKey: state.active_step });
    if (!step) {
      await clearConversationState({ tenantId, canal, senderId });
      return { reply: null, didHandle: false };
    }

    const parsed = validateExpected(step.expected, userInput);

    if (!parsed.ok) {
      // Repetir prompt del mismo step (sin hardcode)
      const prompt = pickPrompt(step, lang);
      return { reply: prompt, didHandle: true };
    }

    // ✅ Persistir decisión si el step lo define (DB-driven)
    await persistDecisionFromStep({
      tenantId,
      canal,
      senderId,
      stepKey: step.step_key,
      expected: step.expected,
      parsedValue: parsed.value,
    });

    // Si el step marca next = done/null, cerramos flow
    const next = step.on_success_next_step;

    if (!next || next === "done") {
      await clearConversationState({ tenantId, canal, senderId });

      if (step.expected?.persist_complete_key) {
          await setMemoryValue({
          tenantId,
          canal,
          senderId,
          key: step.expected.persist_complete_key,
          value: true,
          });
      }

      // ✅ Sí manejamos el turno: cortamos el pipeline aunque no haya reply
      return { reply: null, didHandle: true };
    }

    // Avanzar al siguiente step
    await setConversationState({
      tenantId,
      canal,
      senderId,
      activeFlow: flow.flow_key,
      activeStep: next,
      context: state.context ?? {},
    });

    // ✅ Antes de preguntar el siguiente step, intentamos auto-avanzar usando memoria
    const auto = await autoAdvanceUsingMemory({
    tenantId,
    canal,
    senderId,
    lang,
    flow,
    state: {
        ...state,
        active_flow: flow.flow_key,
        active_step: next,
        context: state.context ?? {},
    },
    });

    if (!auto.stepToAsk) {
    // Flow terminó o no hay nada que preguntar
    return { reply: null, didHandle: true };
    }

    return { reply: pickPrompt(auto.stepToAsk, lang), didHandle: true };
  }

    // 2) Si NO hay state: decidir si iniciar onboarding
    const onboardingCompleted = await getMemoryValue<boolean>({
      tenantId,
      canal,
      senderId,
      key: "onboarding_completed",
    });

    console.log("🧠 [FlowEngine] onboardingCompleted?", {
      onboardingCompleted,
      willStartFlow: !onboardingCompleted,
      isChannelKeyword: isChannelKeyword(userInput),
    });

    // ✅ Si el usuario dice un canal, iniciamos el flow igual (sirve para reconfigurar)
    // Esto evita caer al pipeline normal con inputs tipo "facebook".
    if (isChannelKeyword(userInput)) {
    const flow = await getFlowByKey({ tenantId, flowKey: "onboarding" });
    if (!flow || !flow.enabled) return { reply: null, didHandle: false };

    // ponemos state en select_channel
    await setConversationState({
        tenantId,
        canal,
        senderId,
        activeFlow: flow.flow_key,
        activeStep: "select_channel",
        context: {},
    });

    const step = await getStepByKey({ flowId: flow.id, stepKey: "select_channel" });
    if (!step) return { reply: null, didHandle: false };

    // ✅ PROCESAR EL INPUT ACTUAL COMO RESPUESTA DEL STEP (NO repetir prompt)
    const parsed = validateExpected(step.expected, userInput);

    if (!parsed.ok) {
        // si por alguna razón no matchea, preguntamos normal
        return { reply: pickPrompt(step, lang), didHandle: true };
    }

    // persistir channels_selected
    await persistDecisionFromStep({
        tenantId,
        canal,
        senderId,
        stepKey: step.step_key,
        expected: step.expected,
        parsedValue: parsed.value,
    });

    const next = step.on_success_next_step;

    // si termina
    if (!next || next === "done") {
        await clearConversationState({ tenantId, canal, senderId });

        if (step.expected?.persist_complete_key) {
        await setMemoryValue({
            tenantId,
            canal,
            senderId,
            key: step.expected.persist_complete_key,
            value: true,
        });
        }

        return { reply: null, didHandle: true };
    }

    // avanzar
    await setConversationState({
        tenantId,
        canal,
        senderId,
        activeFlow: flow.flow_key,
        activeStep: next,
        context: {},
    });

    // preguntar el siguiente step
    const nextStep = await getStepByKey({ flowId: flow.id, stepKey: next });
    if (!nextStep) return { reply: null, didHandle: true };

    return { reply: pickPrompt(nextStep, lang), didHandle: true };
    }

    // Flujo “primera vez”
    if (!onboardingCompleted) {
    const flow = await getFlowByKey({ tenantId, flowKey: "onboarding" });
    console.log("🧠 [FlowEngine] flow loaded", { flowExists: !!flow, enabled: flow?.enabled, flow });
    if (!flow || !flow.enabled) return { reply: null, didHandle: false };

    await setConversationState({
        tenantId,
        canal,
        senderId,
        activeFlow: flow.flow_key,
        activeStep: "select_channel",
        context: {},
    });

    // ✅ Auto-advance: si ya hay memoria para este step, saltarlo
    const auto = await autoAdvanceUsingMemory({
        tenantId,
        canal,
        senderId,
        lang,
        flow,
        state: { active_flow: flow.flow_key, active_step: "select_channel", context: {} },
    });

    if (!auto.stepToAsk) {
        // el flow terminó o no hay nada que preguntar
        return { reply: null, didHandle: true };
    }

    return { reply: pickPrompt(auto.stepToAsk, lang), didHandle: true };
    }

    return { reply: null, didHandle: false };

}
