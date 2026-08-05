# V2 异步导入实现说明

完整需求文件位于 `E:\ai\exam4\aiExam-v2-async-import-design.md`。本项目 `E:\work\aiExam-v2` 是该需求中的 V2 独立系统。

## 已实现链路

- `POST /api/import-tasks`：在单事务中创建 `import_tasks`、`import_task_rows`、`import_task_batches` 和 `event_outbox`。
- `POST /api/import-dispatcher/tick`：扫描 Outbox，将待处理批次置为 `queued`。
- `POST /api/import-worker/tick`：恢复超时批次、抢占队列批次、批量 SKU 校验、批量 UPSERT、写错误和性能日志。
- `GET /api/import-tasks/:taskId`：查询任务进度。
- `GET /api/import-tasks/:taskId/errors`：按批次、错误码和分页查询行级错误。
- `GET /api/import-tasks/:taskId/batches`：查询批次状态。
- `GET /api/import-monitor/summary`：聚合吞吐、队列深度、阶段耗时、错误分布和慢批次。
- `GET /api/traces/:traceId`：查询任务和批次 Trace 时间线。

## 性能与幂等点

- 批次大小默认 `IMPORT_BATCH_SIZE=1000`。
- Worker 每次消费批次数默认 `IMPORT_WORKER_BATCH_LIMIT=2`。
- 批次抢占使用 `FOR UPDATE SKIP LOCKED`。
- SKU 主数据使用 `WHERE sku_code = ANY($1::text[])` 批量查询。
- 运单写入使用 JSONB 批量 `INSERT ... ON CONFLICT DO UPDATE`。
- 任务统计从批次聚合刷新，避免重复消费导致计数膨胀。
- `IMPORT_FORCE_SKU_DEGRADED=1` 可模拟 SKU 校验降级，任务和 Trace 会记录降级状态。

## V3 联动

V2 对外提供：

- `GET /api/v1/waybills?q=keyword&limit=20`
- `GET /api/v1/waybills/:waybillNo`
- `GET /api/v1/waybills/:waybillNo/skus/:skuCode`

V3 项目 `E:\work\aiExam` 通过 `V2_API_BASE_URL=http://127.0.0.1:3001/api/v1` 调用这些接口，不直接连接 V2 数据库。

## 验收命令

```powershell
npm run typecheck
npm run build
npm run seed:perf
npm run loadtest:import
```

真实 10,000 行和 60 秒目标验收需要先配置 PostgreSQL 连接串。
