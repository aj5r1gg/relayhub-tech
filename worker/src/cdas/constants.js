export const CDAS_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
export const CDAS_DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;

export const CDAS_GENERATED_PREFIX = "docs/generated/cdas/";

export const CDAS_DEFAULT_RECIPIENT_CATEGORY = "public_reader";

export const CDAS_DOCUMENT_STATUSES = {
  DRAFT: "draft",
  REVIEW: "review",
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  WITHDRAWN: "withdrawn",
  RETIRED: "retired",
  ARCHIVED: "archived",
  RESTRICTED: "restricted",
  DISABLED: "disabled",
};

export const CDAS_CLASSIFICATIONS = {
  PUBLIC_OPEN: "public_open",
  PUBLIC_LICENSED: "public_licensed",
  CONTROLLED: "controlled",
  RESTRICTED: "restricted",
  CONFIDENTIAL: "confidential",
  RETIRED_PUBLIC: "retired_public",
  WITHDRAWN: "withdrawn",
  INTERNAL_ONLY: "internal_only",
};

export const CDAS_ACCESS_CLASSES = {
  DIRECT_PUBLIC: "direct_public",
  VERIFIED_PUBLIC: "verified_public",
  LICENSED_PUBLIC: "licensed_public",
  CONTROLLED_VERIFIED: "controlled_verified",
  APPROVAL_REQUIRED: "approval_required",
  INVITE_ONLY: "invite_only",
  PAID_VERIFIED: "paid_verified",
  DISABLED: "disabled",
};

export const CDAS_REQUEST_STATUSES = {
  CREATED: "created",
  EMAIL_PENDING: "email_pending",
  EMAIL_SENT: "email_sent",
  EMAIL_FAILED: "email_failed",
  EMAIL_VERIFIED: "email_verified",
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "approved",
  DENIED: "denied",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  LICENCE_ISSUED: "licence_issued",
  DOWNLOAD_READY: "download_ready",
  DOWNLOADED: "downloaded",
  CLOSED: "closed",
};

export const CDAS_LICENCE_STATUSES = {
  ISSUED: "issued",
  ACTIVE: "active",
  EXPIRED: "expired",
  REVOKED: "revoked",
  SUPERSEDED: "superseded",
  VOIDED: "voided",
  CORRECTED: "corrected",
  UNDER_REVIEW: "under_review",
  SUSPECTED_LEAK: "suspected_leak",
  CONFIRMED_LEAK: "confirmed_leak",
};

export const CDAS_DOWNLOAD_LINK_STATUSES = {
  CREATED: "created",
  SENT: "sent",
  USED: "used",
  EXPIRED: "expired",
  REVOKED: "revoked",
  SUPERSEDED: "superseded",
  FAILED: "failed",
};

export const CDAS_TERMS_STATUSES = {
  DRAFT: "draft",
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  RETIRED: "retired",
  WITHDRAWN: "withdrawn",
};

export const CDAS_EMAIL_DOMAIN_STATUSES = {
  ALLOWED: "allowed",
  REVIEW: "review",
  BLOCKED: "blocked",
  INTERNAL: "internal",
  PARTNER: "partner",
  UNKNOWN: "unknown",
};