//src/lib/voice/returningCustomer/buildReturningCustomerBookingSeed.ts
import type {
  ReturningCustomerBookingSeed,
  ReturningCustomerContext,
} from "./types";

export function buildReturningCustomerBookingSeed(
  customer: ReturningCustomerContext
): ReturningCustomerBookingSeed {
  return {
    customer_name: customer.fullName,
    customer_phone: customer.phone,
  };
}