# PDF Logo Remover (Node MVP)

Monorepo with:
- `apps/api`: upload + jobs API (Fastify)
- `apps/worker`: async processor (BullMQ)
- `apps/web`: upload/status UI (Next.js)

## 1. Quick start
1. Copy env:
```bash
cp .env.example .env
```
2. Start Redis:
```bash
docker compose up -d redis
```
3. Install deps:
```bash
npm install
```
4. Run all services:
```bash
npm run dev
```

## 2. URLs
- Web: `http://localhost:3000`
- API health: `http://localhost:3001/health`

## 3. Current processing behavior
Worker now runs an AI detector-driven `overlay` pipeline:
- Renders each page with `pdfjs-dist`
- Uses OpenAI Vision with your logo references from `samples/logo-refs`
- Gets logo bbox in normalized coordinates
- Draws a rectangle over the detected logo using sampled surrounding color
- Writes audit JSON per page

## 4. Detection assets
Put logo reference images in:
- `samples/logo-refs`

Put test PDFs in:
- `samples/input-pdf`

Set these in `.env`:
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-4.1-mini`)

Tune thresholds in `.env`:
- `AUTO_THRESHOLD` (default `0.85`)
- `REVIEW_THRESHOLD` (default `0.70`)
