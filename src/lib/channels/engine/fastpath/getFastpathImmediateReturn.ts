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

function toTrimmedString(value: any): string {
  return String(value ?? "").trim();
}

export function getFastpathImmediateReturn(
  input: FastpathImmediateReturnInput
): FastpathImmediateReturnDecision {
  const fpSource = toTrimmedString(input.fp?.source);
  const fpIntent = toTrimmedString(
    input.fp?.intent || input.detectedIntent || input.intentFallback
  );
  const fpReply = toTrimmedString(input.fp?.reply);

  const isServiceDetailDirectReturn =
    input.replyPolicy.isDmChannel &&
    fpSource === "service_list_db" &&
    (
      fpIntent === "info_servicio" ||
      input.catalogReferenceClassification?.intent === "includes"
    );

  const shouldReturnImmediately =
    Boolean(input.replyPolicy.shouldDirectReturnPriceLikeReply) ||
    Boolean(input.replyPolicy.shouldDirectReturnInfoBlock) ||
    isServiceDetailDirectReturn;

    return {
      shouldReturnImmediately,
      reply: shouldReturnImmediately ? fpReply : undefined,
      replySource: shouldReturnImmediately ? fpSource || undefined : undefined,
      intent: shouldReturnImmediately ? fpIntent || null : null,
    };
}