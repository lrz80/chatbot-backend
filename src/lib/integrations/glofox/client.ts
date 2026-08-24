// src/lib/integrations/glofox/client.ts

import {
  GlofoxApiError,
  type GlofoxRequestOptions,
} from "./types";

import {
  getGlofoxConfigForTenant,
  type ResolvedGlofoxConfig,
} from "./config";

const GLOFOX_REQUEST_TIMEOUT_MS = 10_000;

function buildQueryString(
  query?: GlofoxRequestOptions["query"]
): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (
      value === undefined ||
      value === null
    ) {
      continue;
    }

    params.set(key, String(value));
  }

  const serialized = params.toString();

  return serialized
    ? `?${serialized}`
    : "";
}

function resolveGlofoxBaseUrl(
  config: ResolvedGlofoxConfig
): string {
  /**
   * Glofox documentation currently shows:
   *
   * https://gf-api.aws.glofox.com/prod
   *
   * for production requests.
   *
   * We intentionally do not invent sandbox/staging URLs.
   * Add those mappings only when confirmed by Glofox.
   */
  if (config.environment === "production") {
    return "https://gf-api.aws.glofox.com/prod";
  }

  throw new GlofoxApiError(
    "GLOFOX_INVALID_CONFIG",
    `Glofox base URL is not configured for environment: ${config.environment}`
  );
}

function mapHttpError(
  status: number
): GlofoxApiError {
  if (status === 401) {
    return new GlofoxApiError(
      "GLOFOX_UNAUTHORIZED",
      "Glofox rejected the API credentials.",
      status
    );
  }

  if (status === 403) {
    return new GlofoxApiError(
      "GLOFOX_FORBIDDEN",
      "Glofox denied access to this resource.",
      status
    );
  }

  if (status === 404) {
    return new GlofoxApiError(
      "GLOFOX_NOT_FOUND",
      "The requested Glofox resource was not found.",
      status
    );
  }

  if (status === 429) {
    return new GlofoxApiError(
      "GLOFOX_RATE_LIMITED",
      "Glofox API rate limit exceeded.",
      status
    );
  }

  return new GlofoxApiError(
    "GLOFOX_REQUEST_FAILED",
    `Glofox API request failed with HTTP ${status}.`,
    status
  );
}

export class GlofoxClient {
  private readonly config: ResolvedGlofoxConfig;
  private readonly baseUrl: string;

  private constructor(
    config: ResolvedGlofoxConfig
  ) {
    this.config = config;
    this.baseUrl = resolveGlofoxBaseUrl(config);
  }

  static async forTenant(
    tenantId: string
  ): Promise<GlofoxClient> {
    const config =
      await getGlofoxConfigForTenant(
        tenantId
      );

    return new GlofoxClient(config);
  }

  async request<T>(
    options: GlofoxRequestOptions
  ): Promise<T> {
    const method =
      options.method ?? "GET";

    const path =
      options.path.startsWith("/")
        ? options.path
        : `/${options.path}`;

    const url =
      `${this.baseUrl}${path}` +
      buildQueryString(options.query);

    const controller =
      new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      GLOFOX_REQUEST_TIMEOUT_MS
    );

    try {
      let response: Response;

      try {
        response = await fetch(url, {
          method,

          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",

            "x-glofox-branch-id":
              this.config.branchId,

            "x-api-key":
              this.config.apiKey,

            "x-glofox-api-token":
              this.config.apiToken,
          },

          body:
            options.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,

          signal: controller.signal,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AbortError"
        ) {
          throw new GlofoxApiError(
            "GLOFOX_REQUEST_FAILED",
            "Glofox API request timed out."
          );
        }

        throw new GlofoxApiError(
          "GLOFOX_REQUEST_FAILED",
          "Unable to reach the Glofox API."
        );
      }

      if (!response.ok) {
        throw mapHttpError(response.status);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType =
        response.headers.get(
          "content-type"
        ) ?? "";

      if (
        !contentType
          .toLowerCase()
          .includes("application/json")
      ) {
        throw new GlofoxApiError(
          "GLOFOX_INVALID_RESPONSE",
          "Glofox returned a non-JSON response.",
          response.status
        );
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new GlofoxApiError(
          "GLOFOX_INVALID_RESPONSE",
          "Glofox returned invalid JSON.",
          response.status
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}