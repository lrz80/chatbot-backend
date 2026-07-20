// src/modules/field-operations/providers/routingProviderRegistry.ts

import { LocalApproximateRoutingProvider } from "./localApproximateRouting.provider";
import type { RoutingProvider } from "./routingProvider.types";

const providers = new Map<string, RoutingProvider>();

function normalizeProviderName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function registerRoutingProvider(
  provider: RoutingProvider
): void {
  const providerName = normalizeProviderName(provider.name);

  if (!providerName) {
    throw new Error(
      "FIELD_OPERATIONS_ROUTING_PROVIDER_NAME_REQUIRED"
    );
  }

  providers.set(providerName, provider);
}

export function getRoutingProvider(
  providerName?: string | null
): RoutingProvider {
  const normalizedName = normalizeProviderName(
    providerName ?? "local_approximate"
  );

  const provider = providers.get(normalizedName);

  if (!provider) {
    throw new Error(
      `FIELD_OPERATIONS_ROUTING_PROVIDER_NOT_FOUND:${normalizedName}`
    );
  }

  return provider;
}

export function listRegisteredRoutingProviders(): string[] {
  return Array.from(providers.keys()).sort();
}

registerRoutingProvider(
  new LocalApproximateRoutingProvider()
);