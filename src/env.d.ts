type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}

interface Env {
  RELAYHUB_DOWNLOADS: R2Bucket;
  RELAYHUB_DB: D1Database;
  RELAYHUB_RATE_LIMIT: KVNamespace;
  DOWNLOAD_ANALYTICS: AnalyticsEngineDataset;
  RELAYHUB_EMAIL: SendEmail;
}