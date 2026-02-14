# DEVELPMENT_GUIDES

## 1. Project Goal
Build a Node.js system where users upload a PDF and receive a processed PDF with the logo removed, with auditability and safe defaults.

## 2. Proposed Architecture
- `apps/web`: Next.js frontend for upload, job status, and file download.
- `apps/api`: Fastify API to create jobs, expose status, and serve output.
- `apps/worker`: BullMQ worker to process PDFs asynchronously.
- `Redis`: queue backend for BullMQ.
- `Redis`: queue backend and current job status storage for MVP.
- `Postgres` (optional next step): durable metadata and reporting.
- `Object Storage`: local disk for dev, S3-compatible storage for prod.

## 3. High-Level Flow
1. User uploads PDF in `web`.
2. `api` validates file and creates a processing job.
3. `api` stores input PDF and enqueues job in BullMQ.
4. `worker` renders pages to images (300 DPI).
5. `worker` runs logo detection in ROI (e.g. top-right region).
6. `worker` applies removal strategy:
   - Primary: PDF overlay rectangle in detected bounding box.
   - Optional hard mode: raster inpainting + rebuild page.
7. `worker` stores output PDF and writes audit rows.
8. User polls status and downloads cleaned file.

## 4. Tech Stack
- API: `fastify`, `zod`, `bullmq`, `ioredis`, `@aws-sdk/client-s3` (or local FS adapter)
- Worker: `bullmq`, `onnxruntime-node`, `sharp`, `node-poppler`, `pdf-lib`
- Web: `next`, `react-hook-form`, simple polling for status
- DB (phase 2): `postgres` + `drizzle` or `prisma`

## 5. Services and Contracts
### 5.1 API Endpoints
- `POST /v1/jobs`
  - Request: `multipart/form-data` with `file`
  - Response: `{ jobId, status: "queued" }`
- `GET /v1/jobs/:jobId`
  - Response: `{ jobId, status, progress, pagesProcessed, pagesTotal, startedAt, finishedAt, error? }`
- `GET /v1/jobs/:jobId/download`
  - Returns cleaned PDF if `status=completed`
- `GET /v1/jobs/:jobId/audit`
  - Returns JSON audit by page and detection score

### 5.2 Job Payload
```json
{
  "jobId": "uuid",
  "inputKey": "uploads/2026/02/file.pdf",
  "settings": {
    "autoThreshold": 0.75,
    "reviewThreshold": 0.45,
    "mode": "overlay",
    "roi": "top_right"
  }
}
```

## 6. Detection Strategy
Use a hybrid strategy for precision and speed:
1. Restrict detection to ROI (expected logo zone).
2. Run ONNX detector (YOLO exported to ONNX).
3. Optional second pass template match when confidence is borderline.
4. Decision policy:
   - `score >= 0.75`: auto-remove
   - `0.45 <= score < 0.75`: mark as `needs_review`
   - `< 0.45`: no action

## 7. PDF Removal Modes
### 7.1 Overlay Mode (MVP)
- Use `pdf-lib` to draw a white rectangle over detected bbox.
- Pros: fast, preserves text layer.
- Cons: underlying vector/logo may still exist in object structure.

### 7.2 Hard Remove Mode (Later)
- Render page image, inpaint/mask logo area, rebuild PDF page.
- Pros: harder to recover original logo.
- Cons: may lose text-selectability unless OCR re-layering is added.

## 8. Data Model (Minimal)
### Table: `jobs` (Phase 2)
- `id` (uuid, pk)
- `status` (`queued|processing|completed|failed|needs_review`)
- `input_key` (text)
- `output_key` (text, nullable)
- `mode` (text)
- `created_at`, `started_at`, `finished_at`
- `error_message` (text, nullable)

### Table: `job_pages` (Phase 2)
- `id` (uuid, pk)
- `job_id` (fk)
- `page_number` (int)
- `detection_score` (float)
- `bbox` (jsonb)
- `action` (`none|removed|review`)

## 9. Local Development
## 9.1 Prerequisites
- Node 20+
- Redis
- Postgres (optional in MVP, required in phase 2)
- Poppler installed on machine

## 9.2 Environment Variables
```env
NODE_ENV=development
API_PORT=3001
WEB_PORT=3000
REDIS_URL=redis://localhost:6379
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=./.storage
AUTO_THRESHOLD=0.75
REVIEW_THRESHOLD=0.45
```

## 9.3 Suggested Monorepo Layout
```txt
apps/
  api/
  worker/
  web/
packages/
  shared-types/
  detection/
  pdf-processing/
  storage/
```

## 10. Security and Reliability
- Validate MIME type and PDF signature before processing.
- Limit file size and max page count.
- Add per-IP/user rate limiting on upload endpoints.
- Use isolated temp directories per job.
- Store immutable audit trail per page decision.
- Add retry policy with exponential backoff in worker.

## 11. Testing Strategy
- Unit tests for decision policy and bbox transforms.
- Integration tests for API + queue + worker using sample PDFs.
- Golden-file regression tests:
  - input PDF -> output PDF + expected audit JSON
- Manual review set for false positive/false negative monitoring.

## 12. MVP Implementation Order
1. Scaffold `api`, `worker`, `web` apps.
2. Add file upload + job queue + status endpoints.
3. Add page rendering + ROI crop.
4. Integrate ONNX detection.
5. Apply overlay removal and save output PDF.
6. Add audit endpoint and CSV export.
7. Add review flow for borderline scores.

## 13. Definition of Done (MVP)
- Upload a PDF from UI.
- Receive processed PDF download link.
- Job status transitions are visible.
- Audit shows page-level score, bbox, and action.
- At least 90% detection recall on your validation sample set.

## 14. Notes for Your Case
Since most files place the logo in the same region, ROI-based detection should give you lower cost and lower false positives versus full-page detection.
