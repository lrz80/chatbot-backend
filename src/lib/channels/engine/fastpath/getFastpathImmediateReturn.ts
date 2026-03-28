export type FastpathImmediateReturnInput = {
  fp: {
    source?: string | null;
    intent?: string | null;
    reply?: string | null;
  };
  detectedIntent?: string | null;
  intentFallback?: string | null;
  replyPolicy: {
    shouldDirectReturnPriceLikeReply: boolean;
    shouldDirectReturnInfoBlock: boolean;
    isDmChannel: boolean;
  };
  catalogReferenceClassification?: any;
};

export type FastpathImmediateReturnDecision = {
  shouldReturnImmediately: boolean;
  reply?: string;
  replySource?: string;
  intent: string | null;
};

export function getFastpathImmediateReturn(
  input: FastpathImmediateReturnInput
): FastpathImmediateReturnDecision {
  void input;

  return {
    shouldReturnImmediately: false,
    reply: undefined,
    replySource: undefined,
    intent: null,
  };
}