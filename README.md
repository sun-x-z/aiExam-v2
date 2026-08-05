# AI Exam V2

Standalone V2 waybill import service. It keeps the original import, parse-rule, batch-submit and shipment-query workflow, and exposes HTTP APIs consumed by the V3 exception workflow.

## Local Run

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:3001`.

## Environment

Set one PostgreSQL connection variable:

- `DATABASE_URL`
- `POSTGRES_URL_NON_POOLING`
- `POSTGRES_URL`
- `NEON_DATABASE_URL`
- `NEON_POSTGRES_URL`

Optional AI rule-generation variables:

- `AI_API_KEY`
- `AI_API_BASE_URL`
- `AI_MODEL`

Async import tuning:

- `IMPORT_BATCH_SIZE=1000`
- `IMPORT_WORKER_BATCH_LIMIT=2`
- `IMPORT_FORCE_SKU_DEGRADED=1` can be used to simulate SKU validation degradation.

V3 integration:

- `V2_API_KEY=local-dev-v2-key`
- V3 should use `V2_API_BASE_URL=http://127.0.0.1:3001/api/v1`.

## HTTP Contract For V3

All requests require:

```http
X-API-Key: <V2_API_KEY>
Accept: application/json
```

- `GET /api/v1/waybills?q=keyword&limit=20`
- `GET /api/v1/waybills/{waybillNo}`
- `GET /api/v1/waybills/{waybillNo}/skus/{skuCode}`

The legacy-compatible `/api/v2/waybills/*` routes are also kept.

## V2 Async Import Flow

The V2 import submit path is task based:

1. Preview still uses the existing V2 parser, parse-rule JSON and validation modules.
2. `POST /api/import-tasks` creates `import_tasks`, `import_task_rows`, `import_task_batches` and `event_outbox` in one PostgreSQL transaction, then returns `task_id` and `trace_id`.
3. `POST /api/import-worker/tick` dispatches pending Outbox events and consumes queued batch units.
4. Worker processing uses batch SKU lookup, row-level error records, batch UPSERT into `shipments`, performance logs and Trace events.
5. The UI polls task progress every 2 seconds and shows task detail, filtered errors, batch status, monitor summary and Trace timeline.

For Vercel, call `/api/import-worker/tick` from Vercel Cron or a separate Worker platform. The local UI also triggers small worker ticks while the task page is open.

## Required Scripts

```powershell
npm run seed:perf
npm run loadtest:import
```

`seed:perf` generates `test-data/10000-orders.xlsx` and, when a database URL is configured, upserts 20,000 SKU rows into `sku_master`. Re-running it deletes only seeded `SKU_%` rows before inserting them again.

`loadtest:import` posts the 10,000-row file to `/api/import-tasks`, runs worker ticks, polls progress and prints upload time, total task time, success/failure rows and whether the 60-second target passed.

## Async Import APIs

- `POST /api/import-tasks`
- `GET /api/import-tasks/:taskId`
- `GET /api/import-tasks/:taskId/errors?batch=1&error_code=E001&page=1&page_size=50`
- `GET /api/import-tasks/:taskId/batches`
- `POST /api/import-dispatcher/tick`
- `POST /api/import-worker/tick`
- `GET /api/import-monitor/summary`
- `GET /api/traces/:traceId`
