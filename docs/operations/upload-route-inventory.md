# RelayHub Website — Controlled Upload Facility Route Inventory

Status: U1-K foundation update  
Scope: Controlled Upload Facility v0.3  
Implementation status: no upload routes implemented yet

## 1. Current Safety Position

The Controlled Upload Facility foundation currently provides helper modules and database tables only.

At this stage there are no public, admin, or internal HTTP upload routes.

This is deliberate.

Upload route creation is blocked until the foundation helpers are validated and the required route gates are wired in.

## 2. Implemented Foundation Components

The following foundation components now exist:

| Component | Status | Purpose |
|---|---:|---|
| upload_transactions table | Implemented | Upload transaction ledger |
| storage_prefixes table | Implemented | Governed R2 prefix registry |
| seeded storage prefixes | Implemented | Safe initial CDAS/private namespaces |
| upload_idempotency_keys table | Implemented | Browser retry/idempotency protection |
| Prefix validation helper | Implemented | Blocks cross-domain and invalid prefixes |
| Object-key builder helper | Implemented | Generates final object keys |
| Hash helper | Implemented | Calculates SHA-256 and file size evidence |
| Multipart parser helper | Implemented | Strict upload form parsing |
| Idempotency helper | Implemented | Detects retries and unsafe replay states |
| Emergency switch helper | Implemented | Upload-specific fail-closed controls |
| Upload audit helper | Implemented | Integrates with admin_audit_events |

## 3. Routes Not Yet Implemented

The following routes are reserved for future implementation only.

They must not exist yet.

| Future Route | Method | Status | Notes |
|---|---:|---:|---|
| /api/admin/uploads/cdas-document | POST | Not implemented | Future controlled CDAS document upload route |
| /api/admin/uploads/private-file | POST | Not implemented | Future controlled private-file upload route |
| /api/admin/uploads/prefixes | GET | Not implemented | Future read-only storage prefix list |
| /api/admin/uploads/prefixes | POST | Not implemented | Future governed prefix creation route |
| /api/admin/uploads/transactions | GET | Not implemented | Future read-only transaction list |
| /api/admin/uploads/transactions/:id | GET | Not implemented | Future upload transaction detail view |
| /api/admin/uploads/transactions/:id/recover | POST | Not implemented | Future recovery action route |
| /api/admin/uploads/evidence/:id | GET | Not implemented | Future evidence view/export route |

## 4. Required Gates Before Any Upload Route Is Created

Every future upload route must pass these gates before doing any write action:

1. Admin authentication gate
2. Upload emergency switch gate
3. Upload-domain switch gate
4. Strict multipart parser gate
5. Prefix validation gate
6. Object-key builder gate
7. Idempotency gate
8. File sanity and hash gate
9. Upload transaction ledger gate
10. Audit event gate
11. Recovery classification gate

No future route may write to R2 before the upload transaction has been created.

No future route may activate, publish, licence, email, or create a download link as a side effect of upload.

## 5. Emergency Switches

The following environment-controlled switches are reserved for upload control:

| Switch | Purpose |
|---|---|
| UPLOADS_ENABLED | Master upload creation switch |
| CDAS_UPLOADS_ENABLED | CDAS document upload switch |
| PRIVATE_FILE_UPLOADS_ENABLED | Private-file upload switch |
| STORAGE_PREFIX_CREATION_ENABLED | Storage prefix creation switch |
| UPLOAD_RECOVERY_ENABLED | Upload recovery action switch |
| UPLOAD_EVIDENCE_EXPORT_ENABLED | Upload evidence export switch |

Disabling upload creation must not disable:

- existing public website pages
- existing CDAS licences
- existing CDAS download links
- existing controlled downloads
- read-only admin visibility
- recovery evidence already recorded

## 6. Reserved Route Behaviour

### POST /api/admin/uploads/cdas-document

Reserved for future CDAS source-document upload.

Required foundation helpers:

- validateStoragePrefixForUpload
- buildCdasSourceObjectKeys
- parseStrictUploadRequest
- buildUploadSourceEvidence
- beginIdempotentUpload
- requireCdasUploadsEnabled
- writeUploadAdminAuditEvent

Must not:

- publish a document
- activate a document
- issue a licence
- create a download link
- send email
- overwrite an existing R2 object

### POST /api/admin/uploads/private-file

Reserved for future private controlled file upload.

Required foundation helpers:

- validateStoragePrefixForUpload
- buildPrivateFileObjectKeys
- parseStrictUploadRequest
- buildUploadSourceEvidence
- beginIdempotentUpload
- requirePrivateFileUploadsEnabled
- writeUploadAdminAuditEvent

Must not:

- create a public listing
- create a public link
- send email
- overwrite an existing R2 object

### GET /api/admin/uploads/prefixes

Reserved for future read-only prefix listing.

Must be read-only.

Must not create, update, disable, or delete prefixes.

### POST /api/admin/uploads/prefixes

Reserved for future governed prefix creation.

Must require:

- admin authentication
- STORAGE_PREFIX_CREATION_ENABLED
- prefix validation
- audit event

Must not allow arbitrary object-key creation.

### GET /api/admin/uploads/transactions

Reserved for future upload transaction visibility.

Must be read-only.

### GET /api/admin/uploads/transactions/:id

Reserved for future upload transaction detail view.

Must be read-only.

### POST /api/admin/uploads/transactions/:id/recover

Reserved for future controlled recovery actions.

Must require:

- admin authentication
- UPLOAD_RECOVERY_ENABLED
- recovery state validation
- audit event

Must not blindly re-upload to the same object key after a failed-after-R2 state.

### GET /api/admin/uploads/evidence/:id

Reserved for future upload evidence view/export.

Must require:

- admin authentication
- UPLOAD_EVIDENCE_EXPORT_ENABLED for export actions
- audit event for export actions

Read-only evidence viewing may remain available even when export is disabled.

## 7. Route Inventory Validation Commands

Use these checks before and after each upload-related implementation step.

### Confirm no upload routes currently exist

Run:

    grep -R "api/admin/uploads\|uploads/cdas-document\|uploads/private-file" -n worker/src src/pages || true

Expected result during U1-K:

    No route handlers should be returned.

### Confirm upload helper modules exist

Run:

    find worker/src/upload -maxdepth 1 -type f -print | sort

Expected helper files:

    worker/src/upload/audit.js
    worker/src/upload/emergency.js
    worker/src/upload/hash.js
    worker/src/upload/idempotency.js
    worker/src/upload/object-keys.js
    worker/src/upload/parse-multipart.js
    worker/src/upload/prefixes.js

### Confirm existing CDAS routes remain untouched

Run:

    grep -R "handleCdas\|/api/admin/cdas\|document-download" -n worker/src | head -80

Expected result:

    Existing CDAS route handlers should still be present.
    No upload route should be required for existing CDAS downloads.

## 8. U1-K Completion Criteria

U1-K is complete when:

- upload route inventory exists
- all future upload routes are marked Not implemented
- helper gates are documented
- emergency switches are documented
- validation commands are documented
- no upload HTTP route has been added
- existing CDAS routes remain unaffected

## 9. U2-E Orchestrator Validation Gate

Status: Passed when local validation reports:

    U2 orchestrator validation failures: 0

Validated behaviours:

- transaction helper accepts valid states and rejects invalid states
- R2 absence helper allows confirmed-missing objects only
- R2 absence helper blocks existing objects
- R2 write helper validates hash and size before write
- R2 write helper writes source, SHA-256 sidecar, and metadata sidecar
- R2 write helper verifies readback
- orchestrator updates upload transaction lifecycle
- orchestrator records admin audit events
- orchestrator blocks overwrite attempts
- orchestrator marks partial R2 write failure as recovery-required
- no upload HTTP route exists yet
- no document is published by upload
- no licence is created by upload
- no download link is created by upload
- no email is sent by upload


## 10. U3-A First Internal Upload Route Skeleton

Route introduced:

    /api/admin/uploads/cdas-document

Status:

    Skeleton only.
    Admin-only.
    Disabled by default.
    Dry-run only.

Policy posture:

- no multipart parsing yet
- no upload transaction creation
- no R2 write
- no document publication
- no licence creation
- no download link creation
- no email
- no private R2 URL exposure
- no raw admin token storage
- no raw IP storage

Required switches for dry-run POST acceptance:

- UPLOADS_ENABLED=true
- CDAS_UPLOADS_ENABLED=true
- UPLOAD_ROUTE_SKELETON_ENABLED=true
- UPLOAD_ROUTE_DRY_RUN_ENABLED=true

Validation gate:

    U3-A route skeleton validation failures: 0

Next gate:

    U3-B — Strict Dry-Run Multipart Parsing Route


## 11. U3-B Strict Dry-Run Multipart Parsing Route

Route:

    /api/admin/uploads/cdas-document

Status:

    Dry-run multipart validation only.

Policy posture:

- admin-only
- disabled unless upload dry-run switches are enabled
- strict multipart parsing enabled
- required CDAS fields validated
- duplicate fields blocked
- unexpected fields blocked
- missing file blocked
- no upload transaction creation
- no R2 write
- no document publication
- no licence creation
- no download link creation
- no email
- no private R2 URL exposure

Required switches for dry-run POST acceptance:

- UPLOADS_ENABLED=true
- CDAS_UPLOADS_ENABLED=true
- UPLOAD_ROUTE_SKELETON_ENABLED=true
- UPLOAD_ROUTE_DRY_RUN_ENABLED=true

Validation gate:

    U3-B strict dry-run multipart validation failures: 0

Next gate:

    U3-C — Dry-Run Prefix Validation and Object-Key Preview


## 12. U3-C Dry-Run Prefix Validation and Object-Key Preview

Route:

    /api/admin/uploads/cdas-document

Status:

    Dry-run prefix validation and object-key preview only.

Policy posture:

- admin-only
- disabled unless upload dry-run switches are enabled
- strict multipart parsing enabled
- storage prefix must exist
- storage prefix must belong to cdas_document
- storage prefix must be active
- storage prefix must remain under docs/originals/relayhub/
- object keys are previewed only
- no upload transaction creation
- no R2 write
- no document publication
- no licence creation
- no download link creation
- no email
- no private R2 URL exposure

Validation gate:

    U3-C dry-run prefix/object-key preview validation failures: 0

Next gate:

    U3-D — Dry-Run Hash Evidence Preview


## 14. U3-E Dry-Run R2 Absence Check

Route:

    /api/admin/uploads/cdas-document

Status:

    Dry-run R2 absence check only.

Policy posture:

- admin-only
- disabled unless upload dry-run switches are enabled
- strict multipart parsing enabled
- storage prefix validation enabled
- object keys previewed only
- SHA-256 evidence calculated
- basic PDF sanity checked
- R2 absence checked for source, SHA-256 sidecar, and metadata sidecar
- existing R2 object blocks upload
- uncertain R2 state blocks upload
- no upload transaction creation
- no R2 write
- no document publication
- no licence creation
- no download link creation
- no email
- no private R2 URL exposure

Validation gate:

    U3-E dry-run R2 absence validation failures: 0

Next gate:

    U3-F — Disabled Real-Write Gate


## 15. U3-F Disabled Real-Write Gate

Route:

    /api/admin/uploads/cdas-document

Status:

    Disabled real-write gate.

Policy posture:

- admin-only
- dry-run remains supported
- real-write intent is recognised
- real-write is disabled by default
- real-write requires UPLOAD_ROUTE_REAL_WRITE_ENABLED=true
- even with the real-write switch enabled, real-write returns not implemented until a later gate wires the transaction and write orchestrator
- no upload transaction creation
- no R2 write
- no document publication
- no licence creation
- no download link creation
- no email
- no private R2 URL exposure

Validation gate:

    U3-F disabled real-write gate validation failures: 0

Next gate:

    U3-G — Real-Write Transaction and Orchestrator Wiring


## 16. U3-G Real-Write Transaction and Orchestrator Wiring

Route:

    /api/admin/uploads/cdas-document

Status:

    Real-write transaction and orchestrator wiring.

Policy posture:

- admin-only
- dry-run remains supported
- real-write intent is recognised
- real-write is disabled by default
- real-write requires UPLOAD_ROUTE_REAL_WRITE_ENABLED=true
- strict multipart parsing enabled
- storage prefix validation enabled
- object keys generated
- SHA-256 evidence calculated
- basic PDF sanity checked
- R2 absence checked before transaction/write
- upload transaction created for real-write mode
- source, SHA-256 sidecar, and metadata sidecar written through upload write orchestrator
- orchestrator owns transaction status updates
- orchestrator owns R2 write helper path
- recovery-required failures are surfaced
- no document publication
- no licence creation
- no download link creation
- no email
- no private R2 URL exposure

Validation gate:

    U3-G real-write transaction/orchestrator validation failures: 0

Next gate:

    U3-H — Real-Write Idempotency Replay Handling


## 17. U3-H Real-Write Idempotency Replay Handling

Route:

    /api/admin/uploads/cdas-document

Status:

    Real-write idempotency replay handling.

Policy posture:

- admin-only
- dry-run remains supported
- real-write remains explicitly gated
- real-write requires client_request_id
- raw client request ID is not stored
- idempotency hash is stored
- completed replay returns existing transaction reference
- completed replay does not create a second transaction
- completed replay does not write R2 again
- in-progress replay is blocked
- recovery-required replay is blocked
- failed/abandoned replay is blocked pending a later controlled retry policy
- successful real-write marks idempotency completed
- failed-before-R2 marks idempotency failed_before_r2
- failed-after-R2 marks idempotency recovery_required / failed_after_r2
- no document publication
- no licence creation
- no download link creation
- no email
- no private R2 URL exposure

Validation gate:

    U3-H idempotency policy validation failures: 0

Next gate:

    U3-I — Real-Write Route Evidence and Recovery Validation


## 18. U3-I Real-Write Route Evidence and Recovery Validation

Route:

    /api/admin/uploads/cdas-document

Status:

    Real-write evidence and recovery validation gate.

Policy posture:

- no new production route behaviour added
- validates U3-G real-write transaction/orchestrator wiring
- validates U3-H idempotency replay handling
- proves upload transaction evidence exists
- proves R2 source object exists
- proves SHA-256 sidecar exists
- proves metadata sidecar exists
- proves source hash matches evidence
- proves completed replay does not write R2 again
- proves missing client_request_id blocks real-write
- proves existing R2 object blocks overwrite
- proves partial R2 failure produces recovery-required evidence
- proves no document publication occurs
- proves no licence is created
- proves no download link is created
- proves no email is sent
- proves no public exposure is created

Evidence artefact:

    docs/evidence/uploads/upload-phase-u3-cdas-upload-proof.txt

Validation gate:

    U3-I policy evidence validation failures: 0

Additional evidence required before promotion:

- successful real-write transaction ID
- source object key
- source SHA-256
- R2 SHA-256 sidecar readback
- R2 metadata sidecar readback
- upload transaction query result
- idempotency query result
- replay query result
- recovery-required failure proof
- negative publication/licence/link/email proof
- public exposure negative test proof

Next gate:

    U3-J — CDAS Draft Document Record Creation Gate


## 20. U3-K CDAS Draft Document Evidence and Admin Visibility Gate

Route:

    /api/admin/uploads/cdas-document

Status:

    CDAS draft document evidence and admin visibility gate.

Policy posture:

- admin-only
- real-write remains explicitly gated
- uploaded source remains controlled intake
- draft documents row is visible to admin workflows
- admin review path is declared
- admin review is required before activation
- document remains draft
- document remains unlisted
- document remains not publicly requestable
- document remains not publicly downloadable
- no public URL is created
- no generated PDF is created
- no licence is issued
- no download link is created
- no email is sent
- completed idempotency replay returns existing transaction reference and does not write again
- uploaded draft can be reviewed in /admin/cdas-documents

Validation gate:

    U3-K admin visibility policy validation failures: 0

Additional evidence required:

- dry-run response includes admin_visibility_preview
- real-write response includes admin_visibility
- admin can locate uploaded draft in CDAS documents admin surface
- draft row has status = draft
- draft row has is_listed = 0
- draft row has requires_approval = 1
- public listing test returns no exposure
- public request/download route cannot access the draft
- no document_licences row exists
- no document_download_links row exists
- no email delivery event exists

Next gate:

    U3-L — CDAS Draft Review Action Gate


## 21. U3-L CDAS Draft Review Action Gate

Routes:

    /api/admin/uploads/cdas-document
    /api/admin/uploads/cdas-document/review

Status:

    CDAS draft review action gate.

Policy posture:

- admin-only
- review actions are explicitly gated
- review route requires CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED=true
- reviewable document must be draft
- reviewable document must be unlisted
- reviewable document must require approval
- allowed actions are hold, reject, and approve_for_activation_prep
- review actions create review events only
- review actions do not activate documents
- review actions do not publish documents
- review actions do not make documents requestable
- review actions do not generate PDFs
- review actions do not issue licences
- review actions do not create download links
- review actions do not send email
- approve_for_activation_prep only permits a later explicit activation-prep gate

Validation gate:

    U3-L draft review action policy validation failures: 0

Additional evidence required:

- GET review route reports policy status
- POST hold records review event
- POST reject records review event
- POST approve_for_activation_prep records review event
- non-draft document is rejected
- listed document is rejected
- document not requiring approval is rejected
- disabled switch blocks review action
- no document activation occurs
- no licence row is created
- no download link row is created
- no email event is created
- no public exposure is created

Next gate:

    U3-M — CDAS Activation Preparation Gate

