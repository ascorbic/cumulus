// Shared between cloudflare.config.ts (dev/build/deploy) and vite.config.ts
// (tests) so the test runtime always matches the deployed runtime.
export const compatibilityDate = "2026-08-18";
export const compatibilityFlags = ["nodejs_compat"];
