//src/lib/voice/returningCustomer/types.ts
export type ReturningCustomerBookingSeed = {
  customer_name: string;
  customer_phone: string;
};

export type ReturningCustomerContext = {
  isReturningCustomer: true;
  contactId: number;
  firstName: string;
  fullName: string;
  phone: string;
  language: string;
  reservations: number;
  bookingSeed: ReturningCustomerBookingSeed;
};

export type ReturningCustomerNotFound = {
  isReturningCustomer: false;
  reason:
    | "TENANT_MISSING"
    | "PHONE_MISSING"
    | "PHONE_INVALID"
    | "CONTACT_NOT_FOUND"
    | "CONTACT_NAME_INVALID"
    | "CONTACT_LANGUAGE_MISSING"
    | "NO_RESERVATIONS"
    | "DATABASE_ERROR";
};

export type ResolveReturningCustomerResult =
  | ReturningCustomerContext
  | ReturningCustomerNotFound;

export type ReturningCustomerGreetingInput = {
  language: string;
  firstName: string;
  businessName: string;
  intent: "returning_customer_welcome";
};