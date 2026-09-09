/** Explicit DOMAIN wins; the established dev service port must never mint production URLs. */
export const DOMAIN = process.env.DOMAIN ?? (process.env.PORT === "3147" ? "dev.openln.com" : "openln.com");
