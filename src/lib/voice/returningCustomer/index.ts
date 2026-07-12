//src/lib/voice/returningCustomer/index.ts
export {
  resolveReturningCustomer,
} from "./resolveReturningCustomer";

export {
  buildReturningCustomerGreetingInput,
} from "./buildReturningCustomerGreeting";

export {
  buildReturningCustomerBookingSeed,
} from "./buildReturningCustomerBookingSeed";

export {
  normalizeReturningCustomerPhone,
} from "./normalizePhone";

export {
  isValidReturningCustomerName,
  resolveReturningCustomerFirstName,
} from "./resolveFirstName";

export type {
  ResolveReturningCustomerResult,
  ReturningCustomerBookingSeed,
  ReturningCustomerContext,
  ReturningCustomerGreetingInput,
  ReturningCustomerNotFound,
} from "./types";