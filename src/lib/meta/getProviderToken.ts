export function getProviderToken() {
  const t = process.env.FACEBOOK_SYSTEM_USER_TOKEN;
  if (!t) throw new Error("Falta FACEBOOK_SYSTEM_USER_TOKEN en env");
  return t;
}
