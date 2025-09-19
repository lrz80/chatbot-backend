// src/lib/featureFlags.ts
export const featureFlags = {
  disableFlows:
    process.env.DISABLE_FLOWS === '1' || (process.env.DISABLE_FLOWS || '').toLowerCase() === 'true',
  disableIntents:
    process.env.DISABLE_INTENTS === '1' || (process.env.DISABLE_INTENTS || '').toLowerCase() === 'true',
};
