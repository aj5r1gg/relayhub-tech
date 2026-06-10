# CDAS Operational Runbook & Recovery Procedures v0.1

Status: Draft  
Owner: RelayHub  
Date: 2026-06-10

---

# 1. Purpose

This runbook explains how to operate, validate, recover, and safely roll back the RelayHub Controlled Document Access System (CDAS).

CDAS is not DRM. It is a controlled, auditable document access and licensing system.

Core rule:

> No verified recipient. No accepted terms. No licence record. No controlled download.

The system is designed around:

- evidence preservation
- auditability
- controlled access
- recovery-first operation
- reproducible deployment
- graceful failure handling

---

# 2. Operating Principles

Operators must follow these principles:

- Preserve evidence.
- Do not overwrite failures.
- Prefer retry records over mutation.
- Keep raw tokens hidden.
- Treat email delivery as auditable but fallible.
- Treat recovery as normal operation.
- Do not expose R2 object URLs.
- Do not bypass licence, verification, or terms gates.
- Do not claim absolute redistribution prevention.

---

# 3. Required Access

The operator requires:

- Cloudflare account access
- Wrangler access
- D1 database access
- R2 bucket access
- Worker deployment access
- Resend account access
- Git repository access
- RelayHub admin token

Required shell variables:

```bash
export RELAYHUB_ADMIN_TOKEN="..."
export RELAYHUB_BASE_URL="https://www.relayhub.tech"
export RELAYHUB_WORKER_URL="https://relayhub-tech.aj5rigg.workers.dev"
export RELAYHUB_D1="relayhub_early_access"
```

---

# 4. Routine Health Check

## Build and Deployment

```bash
npm run build
npx wrangler deploy
git rev-parse HEAD
```

## Validate CDAS Documents

```bash
curl -sS "$RELAYHUB_BASE_URL/api/admin/cdas/documents" \
  -H "Authorization: Bearer $RELAYHUB_ADMIN_TOKEN" \
  | python3 -m json.tool
```

## Validate Email Events

```bash
curl -sS "$RELAYHUB_BASE_URL/api/admin/cdas/email-events" \
  -H "Authorization: Bearer $RELAYHUB_ADMIN_TOKEN" \
  | python3 -m json.tool
```

## Validate D1 Schema

```bash
npx wrangler d1 execute "$RELAYHUB_D1" --remote --command \
"PRAGMA table_info(cdas_email_events);"
```

## Validate Recent Email Evidence

```bash
npx wrangler d1 execute "$RELAYHUB_D1" --remote --command "
SELECT
  id,
  email_type,
  status,
  retryable,
  retry_count,
  retry_of_event_id,
  resolved_at,
  provider_message_id,
  created_at
FROM cdas_email_events
ORDER BY created_at DESC
LIMIT 10;
"
```

---

# 5. Normal Operating Workflow

1. User submits document access request.
2. CDAS records access request.
3. Verification token hash is stored.
4. Verification email is sent.
5. User verifies email.
6. Licence is issued.
7. Generated PDF is created.
8. Controlled download link is issued.
9. Download link is emailed or copied by admin.
10. Recipient opens landing page.
11. Recipient downloads once.
12. Replay attempts are denied.

---

# 6. Email Failure Recovery

Email failure does not invalidate the access request.

Recovery steps:

1. Open:

```text
/admin/cdas-email-events
```

2. Filter by:

```text
failed
```

or

```text
retryable
```

3. Inspect the failed event.

4. Confirm:

```text
retryable = 1
resolved_at = null
status = failed or skipped
```

5. Click:

```text
Retry
```

6. Confirm a new email event is created.

7. Confirm original failed event is marked resolved.

8. Confirm provider message ID is recorded on the retry event.

Do not delete the original failed event.

The original failure is evidence.

---

# 7. Verification Email Resend

Use when the recipient did not receive or lost the verification email.

Admin UI:

```text
/admin/cdas-access-requests
```

Backend endpoint:

```text
POST /api/admin/cdas/access-requests/:id/resend-verification
```

Allowed only for:

- unverified access requests
- open access requests

Blocked states include:

- licence_issued
- denied
- expired
- cancelled

---

# 8. Download Link Recovery

If recipient loses a download email but has not consumed the link:

- inspect download links
- locate current valid link
- copy landing URL
- do not expose raw R2 URLs

If link was already consumed:

- issue a new controlled link only if policy permits redownload
- old link remains consumed
- replay denial remains preserved

Never bypass single-use controls.

---

# 9. Invitation Recovery

If an invitation is lost:

- create a new invitation
- do not attempt to recover the original raw token

Raw invitation tokens are intentionally shown only once.

If an invitation is abused or sent incorrectly:

1. Revoke invitation.
2. Confirm status becomes:

```text
revoked
```

3. Confirm public endpoint returns:

```text
invitation_unavailable
```

4. Preserve invitation record.

Do not delete invitation records.

---

# 10. Generated PDF Recovery

If generated PDF inspection fails:

1. Confirm source document exists in R2.
2. Confirm source SHA is present.
3. Regenerate PDF.
4. Inspect generated PDF.
5. Confirm generated SHA matches stored evidence.
6. Confirm generated file size is recorded.

Do not manually modify generated PDFs.

Generated PDFs are evidence artefacts.

---

# 11. Rollback Procedure

If a deployment causes failure:

1. Stop feature changes.
2. Record failing endpoint.
3. Record exact error.
4. Identify last known good git commit.
5. Revert or checkout known good commit.
6. Build.
7. Deploy.
8. Re-run validation.
9. Record recovery result.

Commands:

```bash
git log --oneline -10

git checkout <known-good-commit>

npm run build

npx wrangler deploy
```

Preferred recovery is:

```text
forward fix
```

when schema changes or evidence tables are already deployed.

---

# 12. Evidence Preservation Rules

Never delete:

- document access requests
- issued licences
- generated PDF evidence
- download events
- email events
- failed email events
- retry events
- invitation records

Prefer:

- status updates
- supersession
- revocation
- retry records
- resolution markers

Evidence preservation takes priority over cosmetic cleanup.

---

# 13. Known Limitations

Current limitations:

- No automatic retry worker.
- No Resend webhook ingestion.
- No delivered tracking.
- No bounce tracking.
- No complaint tracking.
- Paid document workflow not implemented.
- Approval workflow UI not implemented.
- Personal/private namespace UI not implemented.
- Multi-admin identity model not implemented.
- Analytics token redaction still recommended.

---

# 14. Emergency Disable Options

To disable email delivery without disabling CDAS:

```json
"CDAS_EMAIL_ENABLED": "false"
```

Deploy:

```bash
npm run build
npx wrangler deploy
```

Expected behaviour:

- access requests still record
- token hashes still generate
- audit records still generate
- email events record disabled/skipped state
- workflow fails gracefully

---

# 15. Release Classification

Current operational classification:

```text
PASS WITH LIMITATIONS
```

Suitable for:

- controlled public document licensing
- admin-operated document delivery
- validation-backed trials
- non-paid public licensed documents

Not yet suitable for:

- fully automated paid document sales
- unattended production retries
- legal-grade delivery status tracking
- highly sensitive private-client document operations without additional controls

---

# 16. Operator Checklist

Before declaring CDAS healthy:

- [ ] Build passes
- [ ] Deploy succeeds
- [ ] Admin token works
- [ ] Document registry loads
- [ ] Access request flow works
- [ ] Verification email sends
- [ ] Verification consumes token
- [ ] Licence issues
- [ ] PDF generates
- [ ] Download link issues
- [ ] Landing page loads
- [ ] Download consumes once
- [ ] Replay denied
- [ ] Email events recorded
- [ ] Failed email retry works
- [ ] Legacy download endpoints still work

---

# 17. Next Recommended Hardening

1. Redact tokens from analytics referrers.
2. Add Resend webhook ingestion.
3. Add approval workflow UI.
4. Add paid document payment workflow.
5. Add operator dashboard summary.
6. Add periodic validation script.
7. Add release automation validation gates.
8. Add D1 backup validation procedures.
9. Add R2 evidence integrity validation.
10. Add production incident response procedures.

---

# 18. Recovery Classification

CDAS follows RelayHub's recovery-first architecture.

Recovery priority order:

```text
1. Preserve evidence
2. Preserve identity
3. Preserve auditability
4. Restore operation
5. Optimise operation
```

No recovery action should destroy evidence required to explain:

- who requested access
- who received a licence
- what document was delivered
- what email was sent
- what failures occurred
- what recovery actions were performed

---

# 19. Operational Status

Current CDAS status:

```text
PASS WITH LIMITATIONS
```

Validated:

- Document registry
- Licence registry
- Terms registry
- Verification workflow
- Invitation workflow
- Licence generation
- PDF generation
- Download-link workflow
- Email delivery
- Email audit events
- Email retry and recovery
- Admin operational tooling

Next Phase:

```text
3Z-D — CDAS Production Readiness Assessment
```