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
