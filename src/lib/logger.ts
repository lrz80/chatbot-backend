export const DEBUG_LOGS = process.env.DEBUG_LOGS === 'true';

export function debug(...args: any[]) {
  if (DEBUG_LOGS) console.log(...args);
}

export function warn(...args: any[]) {
  console.warn(...args);
}

export function error(...args: any[]) {
  console.error(...args);
}
