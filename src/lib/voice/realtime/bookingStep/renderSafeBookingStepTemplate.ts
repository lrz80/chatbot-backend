// src/lib/voice/realtime/bookingStep/renderSafeBookingStepTemplate.ts
import {
  clean,
  renderBookingStepTemplate,
} from "../realtimeBookingFlowUtils";

type RenderSafeBookingStepTemplateResult =
  | {
      ok: true;
      text: string;
    }
  | {
      ok: false;
      error:
        | "EMPTY_TEMPLATE"
        | "UNRESOLVED_TEMPLATE_PLACEHOLDER"
        | "MALFORMED_TEMPLATE_PLACEHOLDER"
        | "EMPTY_RENDERED_TEMPLATE";
      text: "";
    };

function hasMalformedTemplatePlaceholder(value: string): boolean {
  const text = clean(value);

  if (!text) {
    return false;
  }

  const openCount = (text.match(/\{/g) || []).length;
  const closeCount = (text.match(/\}/g) || []).length;

  if (openCount !== closeCount) {
    return true;
  }

  if (/(^|[^{])\}($|[^}])/.test(text)) {
    return true;
  }

  if (/\{($|[^}]*$)/.test(text)) {
    return true;
  }

  return false;
}

function hasUnresolvedTemplatePlaceholder(value: string): boolean {
  const text = clean(value);

  if (!text) {
    return false;
  }

  return /\{[^{}]+\}/.test(text) || /(^|[^{])\}($|[^}])/.test(text);
}

export function renderSafeBookingStepTemplate(params: {
  template: string;
  values: Record<string, string>;
}): RenderSafeBookingStepTemplateResult {
  const template = clean(params.template);

  if (!template) {
    return {
      ok: false,
      error: "EMPTY_TEMPLATE",
      text: "",
    };
  }

  if (hasMalformedTemplatePlaceholder(template)) {
    return {
      ok: false,
      error: "MALFORMED_TEMPLATE_PLACEHOLDER",
      text: "",
    };
  }

  const rendered = clean(renderBookingStepTemplate(template, params.values));

  if (!rendered) {
    return {
      ok: false,
      error: "EMPTY_RENDERED_TEMPLATE",
      text: "",
    };
  }

  if (hasUnresolvedTemplatePlaceholder(rendered)) {
    return {
      ok: false,
      error: "UNRESOLVED_TEMPLATE_PLACEHOLDER",
      text: "",
    };
  }

  return {
    ok: true,
    text: rendered,
  };
}