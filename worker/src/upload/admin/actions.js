// Canonical CDAS admin workflow action definitions.
//
// Shared by route validation and policy reporting so that permitted action
// names have a single source of truth.

export const VALID_CDAS_DRAFT_REVIEW_ACTIONS = new Set([
  "hold",
  "reject",
  "approve_for_activation_prep",
]);

export const VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS = new Set([
  "list_only",
  "enable_requestability",
  "disable_requestability",
  "unlist",
]);

export const VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS = new Set([
  "hold",
  "reject",
  "approve_for_licence_prep",
]);
