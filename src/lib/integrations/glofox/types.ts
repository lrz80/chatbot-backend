//src/lib/integrations/glofox/types.ts
export type GlofoxEnvironment =
  | "development"
  | "testing"
  | "staging"
  | "sandbox"
  | "production";

export type GlofoxConnectionConfig = {
  tenantId: string;
  branchId: string;
  apiKey: string;
  apiToken: string;
  environment: GlofoxEnvironment;
};

export type GlofoxRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<
    string,
    string | number | boolean | null | undefined
  >;
  body?: unknown;
};

export type GlofoxApiErrorCode =
  | "GLOFOX_INVALID_CONFIG"
  | "GLOFOX_UNAUTHORIZED"
  | "GLOFOX_FORBIDDEN"
  | "GLOFOX_NOT_FOUND"
  | "GLOFOX_RATE_LIMITED"
  | "GLOFOX_REQUEST_FAILED"
  | "GLOFOX_INVALID_RESPONSE";

export class GlofoxApiError extends Error {
  readonly code: GlofoxApiErrorCode;
  readonly status: number | null;

  constructor(
    code: GlofoxApiErrorCode,
    message: string,
    status: number | null = null
  ) {
    super(message);

    this.name = "GlofoxApiError";
    this.code = code;
    this.status = status;
  }
}