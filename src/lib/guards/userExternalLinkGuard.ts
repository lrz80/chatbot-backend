import { answerWithPromptBase } from "../answers/answerWithPromptBase";
import type { Canal } from "../detectarIntencion";
import type { LangCode } from "../i18n/lang";

export type UserExternalLinkDetection = {
  hasExternalLink: boolean;
  urls: string[];
  hosts: string[];
};

export type UserExternalLinkGuardInput = {
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  promptBaseMem: string;
};

export type UserExternalLinkGuardResult =
  | {
      handled: true;
      reply: string;
      source: "user_external_link_unsupported";
      intent: "external_link_unsupported";
      detection: UserExternalLinkDetection;
    }
  | {
      handled: false;
      detection: UserExternalLinkDetection;
      reason?: "no_external_link" | "empty_model_reply";
    };

function trimUrlBoundaryChars(value: string): string {
  let output = String(value || "").trim();

  const openingChars = new Set(["(", "[", "{", "<", "\"", "'", "“", "‘"]);
  const closingChars = new Set([")", "]", "}", ">", "\"", "'", "”", "’", ".", ",", ";"]);

  while (output.length > 0 && openingChars.has(output[0])) {
    output = output.slice(1).trim();
  }

  while (output.length > 0 && closingChars.has(output[output.length - 1])) {
    output = output.slice(0, -1).trim();
  }

  return output;
}

function parseHttpUrlCandidate(value: string): URL | null {
  const cleaned = trimUrlBoundaryChars(value);

  if (!cleaned) {
    return null;
  }

  const candidates = [
    cleaned,
    cleaned.startsWith("www.") ? `https://${cleaned}` : null,
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }

      if (!parsed.hostname || !parsed.hostname.includes(".")) {
        continue;
      }

      return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

export function detectUserExternalLinks(input: string): UserExternalLinkDetection {
  const text = String(input || "").trim();

  if (!text) {
    return {
      hasExternalLink: false,
      urls: [],
      hosts: [],
    };
  }

  const parts: string[] = text
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .split(" ")
    .map((part: string) => part.trim())
    .filter((part: string) => part.length > 0);

  const urls: string[] = [];
  const hosts: string[] = [];

  for (const part of parts) {
    const parsed = parseHttpUrlCandidate(part);

    if (!parsed) {
      continue;
    }

    urls.push(parsed.toString());
    hosts.push(parsed.hostname.toLowerCase());
  }

  const uniqueUrls = Array.from(new Set(urls));
  const uniqueHosts = Array.from(new Set(hosts));

  return {
    hasExternalLink: uniqueUrls.length > 0,
    urls: uniqueUrls,
    hosts: uniqueHosts,
  };
}

export async function userExternalLinkGuard(
  input: UserExternalLinkGuardInput
): Promise<UserExternalLinkGuardResult> {
  const detection = detectUserExternalLinks(input.userInput);

  if (!detection.hasExternalLink) {
    return {
      handled: false,
      detection,
      reason: "no_external_link",
    };
  }

  const canonicalPolicyBody = [
    "The user sent an external link.",
    "The assistant cannot open, inspect, watch, read, verify, or process user-provided external links.",
    "The assistant should ask the user to paste or summarize the relevant information directly in the chat.",
  ].join("\n");

  const response = await answerWithPromptBase({
    tenantId: input.tenantId,
    canal: input.canal,
    idiomaDestino: input.idiomaDestino,
    userInput: input.userInput,
    history: [],
    maxLines: 3,
    fallbackText: "",
    runtimeCapabilities: {
      bookingActive: false,
    },
    promptBase: [
      "SYSTEM_ROLE:",
      "You write a short DM response based only on the canonical policy body.",
      "",
      "CANONICAL_POLICY_BODY:",
      canonicalPolicyBody,
      "",
      "OUTPUT_POLICY:",
      "Write the response in the target language.",
      "Keep it short, natural, and conversational.",
      "Do not use a fixed phrase.",
      "Do not mention internal systems, routing, tools, or policies.",
      "Do not answer from catalog.",
      "Do not answer from business overview.",
      "Do not describe the business.",
      "Do not claim you opened, viewed, watched, verified, or processed the link.",
      "Do not invent what is inside the link.",
      "",
      "PROMPT_BASE:",
      input.promptBaseMem || "",
    ].join("\n"),
    responsePolicy: {
      mode: "grounded_only",
      resolvedEntityType: null,
      resolvedEntityId: null,
      resolvedEntityLabel: null,
      canMentionSpecificPrice: false,
      canSelectSpecificCatalogItem: false,
      canOfferBookingTimes: false,
      canUseOfficialLinks: false,
      unresolvedEntity: false,
      clarificationTarget: null,
      singleResolvedEntityOnly: false,
      allowAlternativeEntities: false,
      allowCrossSellEntities: false,
      allowAddOnSuggestions: false,
      preserveExactBody: false,
      preserveExactOrder: true,
      preserveExactBullets: true,
      preserveExactNumbers: true,
      preserveExactLinks: true,
      allowIntro: false,
      allowOutro: false,
      allowBodyRewrite: true,
      mustEndWithSalesQuestion: false,
      reasoningNotes:
        "Respond only with the external-link capability boundary in the target language. Do not route to catalog or business overview.",
    },
  });

  const reply = String(response.text || "").trim();

  if (!reply) {
    return {
      handled: false,
      detection,
      reason: "empty_model_reply",
    };
  }

  return {
    handled: true,
    reply,
    source: "user_external_link_unsupported",
    intent: "external_link_unsupported",
    detection,
  };
}