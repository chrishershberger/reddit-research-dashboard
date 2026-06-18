// Side-effect import: load a local .env file for development.
// Imported first by the entrypoints so process.env is populated before any
// other module reads it. No-op when .env is absent (e.g. on Railway, where the
// platform injects environment variables directly).
try {
  process.loadEnvFile();
} catch {
  // No .env file present — rely on platform-provided environment variables.
}
