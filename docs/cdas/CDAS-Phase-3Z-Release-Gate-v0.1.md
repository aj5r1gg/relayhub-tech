# CDAS Phase 3Z Release Gate v0.1

## Gate Objective

Confirm CDAS is safe enough for controlled operational use.

CDAS is not DRM. It is a controlled, auditable document access and licensing system.

Core rule:

No verified recipient. No accepted terms. No licence record. No controlled download.

## Gate Status

Status: DRAFT / IN VALIDATION / PASSED / BLOCKED

## 1. Build & Deployment Gate

- [ ] `npm run build` passes
- [ ] `npx wrangler deploy` succeeds
- [ ] deployed Worker version recorded
- [ ] git commit hash recorded
- [ ] rollback commit identified

## 2. Legacy Compatibility Gate

- [ ] `/api/free-download` works
- [ ] `/api/download/:token` works
- [ ] `/api/admin/downloads` works
- [ ] `/api/admin/download-registry` works

## 3. Admin Auth Gate

- [ ] Bearer token auth works
- [ ] query token auth works where intended
- [ ] invalid token rejected
- [ ] missing token rejected
- [ ] admin pages use `sessionStorage["relayhub_admin_token"]`

## 4. Document Registry Gate

- [ ] CDAS documents list loads
- [ ] relayhub-overview active
- [ ] source object present
- [ ] source SHA recorded
- [ ] access class correct
- [ ] licence terms version assigned

## 5. Licence Terms Gate

- [ ] licence terms list loads
- [ ] FREE-PUBLIC-DISTRIBUTION-v0.1 available
- [ ] rendered licence preview works
- [ ] unresolved placeholders handled safely

## 6. Access Request Gate

- [ ] public access form loads
- [ ] terms preview loads
- [ ] request creates document_access_requests row
- [ ] verification token hash stored
- [ ] raw token not stored
- [ ] email_delivery_status recorded

## 7. Email Verification Gate

- [ ] verification email sends through Resend
- [ ] verification endpoint consumes token
- [ ] token hash cleared after verification
- [ ] licence issued after successful verification
- [ ] resend verification works
- [ ] resend blocked for closed/verified records

## 8. Invitation Gate

- [ ] invitation creation works
- [ ] raw invitation token shown once
- [ ] invitation metadata endpoint works
- [ ] invitation-bound request records invitation_id
- [ ] used invitation becomes unavailable
- [ ] revoked invitation becomes unavailable
- [ ] admin invitation UI works

## 9. Licence Evidence Gate

- [ ] issued licence row created
- [ ] rendered licence body captured
- [ ] rendered licence SHA captured
- [ ] rendered terms SHA captured
- [ ] placeholders captured
- [ ] licence number generated

## 10. Generated PDF Gate

- [ ] generation preview works
- [ ] source SHA validation works
- [ ] generated PDF creation works
- [ ] generated PDF evidence recorded
- [ ] generated PDF inspection works
- [ ] PDF object exists in R2
- [ ] generated SHA matches D1 record

## 11. Download Link Gate

- [ ] admin issue download link works
- [ ] landing URL returned
- [ ] raw token shown once
- [ ] metadata endpoint does not consume link
- [ ] download button consumes link once
- [ ] replay denied
- [ ] revoked unused link denied
- [ ] superseded unused link denied

## 12. Download Link Email Gate

- [ ] download-link email sends through Resend
- [ ] email contains landing page URL only
- [ ] no R2 URL exposed
- [ ] single-use controls preserved
- [ ] provider message ID recorded

## 13. Email Audit Gate

- [ ] cdas_email_events records verification emails
- [ ] cdas_email_events records resend emails
- [ ] cdas_email_events records download-link emails
- [ ] provider message ID stored
- [ ] metadata parsed in admin API
- [ ] admin email events UI works

## 14. Email Retry Gate

- [ ] failed email event can be created under controlled test
- [ ] retryable state recorded
- [ ] sent events cannot be retried
- [ ] retry creates new event
- [ ] retry_of_event_id links to original
- [ ] retry_count increments
- [ ] original failed event marked resolved after successful retry
- [ ] admin UI retry button obeys backend state

## 15. Audit & Evidence Gate

- [ ] admin audit events recorded where implemented
- [ ] download events preserve multi-event history
- [ ] email events preserve failure and retry history
- [ ] no evidence rows are overwritten destructively

## 16. Security & Exposure Gate

- [ ] raw R2 URLs never exposed publicly
- [ ] token hashes stored instead of raw tokens
- [ ] public errors are generic
- [ ] admin endpoints require admin auth
- [ ] landing metadata exposes safe fields only
- [ ] CDAS does not claim DRM or absolute redistribution prevention

## 17. Recovery Gate

- [ ] git recovery point exists
- [ ] latest migrations committed
- [ ] rollback command known
- [ ] valid admin token confirmed
- [ ] R2 source objects intact
- [ ] D1 schema verified
- [ ] email disabled mode safe
- [ ] failed email retry path validated

## 18. Known Non-Goals / Not Yet Implemented

- automatic retry worker
- Resend webhook ingestion
- bounced/delivered/opened event tracking
- paid document payment flow
- approval workflow UI
- personal/private namespace UI
- multi-admin identity model
- second-factor recipient gate
- legal review of licence text

## 19. Release Decision

Decision: PASS / PASS WITH LIMITATIONS / BLOCKED

Reviewer:

Date:

Notes: