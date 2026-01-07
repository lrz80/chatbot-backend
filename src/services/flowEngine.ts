import { getConversationState, setConversationState, clearConversationState } from "../lib/conversationState";
import { getMemoryValue, setMemoryValue } from "../lib/clientMemory";


type Canal = "whatsapp" | "facebook" | "instagram" | "sms" | "voice";

export type FlowResult = {
  reply: string | null;
  didHandle: boolean; // true si el motor respondió algo (prompt o mensaje)
};

console.log("🧠 [FlowEngine] MODULE LOADED = V1");

export async function handleMessageWithFlowEngine(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  lang: "es" | "en";
  userInput: string;
}): Promise<FlowResult> {
  // Flows deshabilitados definitivamente.
  // Nunca manejamos el turno aquí: dejamos que el pipeline normal (memoria + FAQs + LLM)
  // responda siempre.
  return { reply: null, didHandle: false };
}

