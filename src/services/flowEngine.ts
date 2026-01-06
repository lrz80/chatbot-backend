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

    // Preguntar el siguiente step
    const nextStep = await getStepByKey({ flowId: flow.id, stepKey: next });
    if (!nextStep) {
      console.log("🛑 [FlowEngine] nextStep NOT FOUND", { flowId: flow.id, next });
      // ✅ Sí manejamos el turno (hay state activo), pero no podemos responder
      // Cortamos pipeline para no caer a FAQ/Intents
      return { reply: null, didHandle: true };
    }

    return { reply: pickPrompt(nextStep, lang), didHandle: true };
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

    // Importante: devolvemos el prompt del step, no el pipeline normal
    return { reply: pickPrompt(step, lang), didHandle: true };
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

    const step = await getStepByKey({ flowId: flow.id, stepKey: "select_channel" });
    console.log("🧠 [FlowEngine] step select_channel", { flowId: flow?.id, stepExists: !!step });

    if (!step) return { reply: null, didHandle: false };

    return { reply: pickPrompt(step, lang), didHandle: true };
    }

    return { reply: null, didHandle: false };

}
