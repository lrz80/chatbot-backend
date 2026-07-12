//src/lib/voice/returningCustomer/buildReturningCustomerGreeting.ts
import type {
  ReturningCustomerContext,
  ReturningCustomerGreetingInput,
} from "./types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildReturningCustomerGreetingInput(params: {
  customer: ReturningCustomerContext;
  businessName: string;
}): ReturningCustomerGreetingInput {
  const businessName = clean(params.businessName);

  return {
    language: params.customer.language,
    firstName: params.customer.firstName,
    businessName: businessName || "the business",
    intent: "returning_customer_welcome",
  };
}