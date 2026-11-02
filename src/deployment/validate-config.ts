import { loadConfig } from "../modules/operations/config.ts";
try {
  loadConfig();
  console.log("Production configuration valid (secret values suppressed).");
} catch (e) {
  // Only our constant validation messages are printable. File/URL parser errors may contain secret paths.
  const message = e instanceof Error ? e.message : "";
  const allowed =
    /^(DATABASE_URL |PUBLIC_ORIGIN |Production entry |EXECUTION_ENABLED |EXECUTION_MODEL |TRUSTED_PROXY_IPS |METRICS_TOKEN |[A-Z_]+ is required$|[A-Z_]+: set value OR _FILE|[A-Z_]+ must be \d)/;
  console.error(
    allowed.test(message)
      ? message
      : "Secret file could not be read or configuration is invalid.",
  );
  process.exitCode = 1;
}
