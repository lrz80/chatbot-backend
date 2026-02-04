// src/lib/conversation/saveConversationState.ts
import { setConversationState as setConversationStateDB } from "../conversationState";

export async function saveConversationState(args: {
  tenantId: string;
  canal: string;
  contacto: string;
  activeFlow: any;
  activeStep: any;
  context: any;
}) {
  return setConversationStateDB({
    tenantId: args.tenantId,
    canal: args.canal,
    senderId: args.contacto,
    activeFlow: args.activeFlow ?? null,
    activeStep: args.activeStep ?? null,
    contextPatch: args.context ?? {},
  });
}
