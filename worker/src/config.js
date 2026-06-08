export const EMAIL_FROM = "hello@relayhub.tech";
export const EMAIL_TO = "moneywise69@proton.me";

export const RATE_LIMIT_MAX_REQUESTS = 5;
export const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
export const MIN_FORM_FILL_TIME_MS = 3000;

export const DOWNLOAD_ALLOWED_PREFIXES = ["docs/"];
export const DOWNLOAD_ALLOWED_EXTENSIONS = [".pdf", ".zip", ".txt", ".sha256", ".sig"];
export const DIRECT_DOWNLOAD_BLOCKED_PREFIXES = [
  "docs/originals/",
  "docs/generated/",
  "docs/audit/",
  "docs/catalogue/",
  "docs/licences/",
];

export const DOCUMENT_CATALOGUE_KEY = "docs/catalogue/documents.json";
export const DOWNLOAD_AUDIT_PREFIX = "docs/audit/downloads/";