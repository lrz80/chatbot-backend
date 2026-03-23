import type { FastpathCtx } from "../../runFastpath";

type HandlePendingLinkGuardrailInput = {
  userInput: string;
  convoCtx: Partial<FastpathCtx> | null | undefined;
  isFreshCatalogPriceTurn: boolean;
};

type HandlePendingLinkGuardrailResult =
  | { handled: false }
  | {
      handled: true;
      ctxPatch: Partial<FastpathCtx>;
    };

function normalizeLocal(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getPendingLinkState(convoCtx: Partial<FastpathCtx> | null | undefined) {
  const ttlMs = 5 * 60 * 1000;

  const pending = Boolean(convoCtx?.pending_link_lookup);
  const pendingAt = Number(convoCtx?.pending_link_at || 0);
  const pendingOptions = Array.isArray(convoCtx?.pending_link_options)
    ? convoCtx.pending_link_options
    : [];

  const pendingFresh =
    pending &&
    pendingAt > 0 &&
    Date.now() - pendingAt <= ttlMs &&
    pendingOptions.length > 0;

  return {
    pending,
    pendingFresh,
    pendingOptions,
  };
}

function buildClearPendingPatch(): Partial<FastpathCtx> {
  return {
    pending_link_lookup: undefined,
    pending_link_at: undefined,
    pending_link_options: undefined,
  };
}

function detectCancelIntent(tNorm: string): boolean {
  return /\b(no|no\s+gracias|gracias|thanks|cancelar|olvidalo|olvídalo|stop)\b/.test(
    tNorm
  );
}

function detectOptionByIndex(
  tNorm: string,
  pendingOptions: any[]
): boolean {
  const m = tNorm.match(/^([1-9])$/);
  if (!m) return false;

  const n = Number(m[1]);
  if (!Number.isFinite(n)) return false;

  return n >= 1 && n <= Math.min(9, pendingOptions.length);
}

function detectLabelWordHit(
  tNorm: string,
  pendingOptions: any[]
): boolean {
  return pendingOptions.some((o: any) => {
    const labelNorm = normalizeLocal(o?.label || "");
    if (!labelNorm) return false;

    const words = labelNorm.split(/\s+/).filter((w) => w.length >= 3);
    return words.some((w) => tNorm.includes(w));
  });
}

export function handlePendingLinkGuardrail(
  input: HandlePendingLinkGuardrailInput
): HandlePendingLinkGuardrailResult {
  const { userInput, convoCtx, isFreshCatalogPriceTurn } = input;

  if (isFreshCatalogPriceTurn) {
    return { handled: false };
  }

  const { pending, pendingFresh, pendingOptions } = getPendingLinkState(convoCtx);

  if (pending && !pendingFresh) {
    return {
      handled: true,
      ctxPatch: buildClearPendingPatch(),
    };
  }

  if (!pendingFresh) {
    return { handled: false };
  }

  const tNorm = normalizeLocal(userInput);

  const looksLikeCancel = detectCancelIntent(tNorm);
  const looksLikeOptionByIndex = detectOptionByIndex(tNorm, pendingOptions);
  const labelWordHit = detectLabelWordHit(tNorm, pendingOptions);

  const looksLikeOptionAnswer = looksLikeOptionByIndex || labelWordHit;

  if (looksLikeCancel || !looksLikeOptionAnswer) {
    return {
      handled: true,
      ctxPatch: buildClearPendingPatch(),
    };
  }

  return { handled: false };
}