# V3 运单全流程管理系统设计文档

## 1. 需求对应的业务逻辑

V3 是独立于 V2 的运单全生命周期管理系统。V2 负责录单解析并沉淀运单主数据，V3 不直接连接 V2 数据库，只通过 HTTP API 获取和校验运单、SKU 信息，并在 V3 独立数据库中保存异常工单、审批记录、扫描记录、赔付记录、库存联动和接口日志。

核心流程如下：

1. 扫描品控：仓库操作员录入运单号、SKU、批次和检测指标，V3 调用 V2 接口校验 SKU 归属。命中可配置品控规则后，批次进入品控暂扣，自动创建品控异常工单。
2. 物流异常上报：操作员手工上报丢件、破损、拒收、超时、地址错误等异常。创建前必须实时调用 V2 校验运单真实存在。
3. 分级审批：工单按可配置金额阈值进入一级或二级审批。审批支持通过、驳回、重提、超时升级/驳回、禁用审批人自动转交。
4. 执行联动：审批通过后按异常类型生成赔付、库存变更、批次解锁等下游记录，和工单状态在同一数据库事务内提交。
5. 追踪与监控：工单详情展示状态变更、审批意见、赔付、库存、扫描记录；接口监控展示 V2 调用日志和 request id。

## 2. 双状态机设计

工单状态机：

- `level1_review`：一级审批中。
- `level2_review`：二级审批中。
- `rejected`：驳回后等待上报人补充重提。
- `completed`：审批通过且下游联动已完成。
- `closed`：超过重提次数或兜底关闭。

扫描批次状态机：

- `outbound_ready`：品控通过，可出库。
- `qc_hold`：命中品控规则，批次锁定，禁止出库。
- `released`：审批通过或品控主管误判复核后解锁。
- `disposed`：重采购/作废类动作完成。

两套状态机通过 `v3_scan_records.ticket_id` 关联。重复扫描同一运单、SKU、批次且存在未关闭品控工单时，只追加扫描记录，不重复创建工单。

## 3. 数据模型

V3 新增表在 [lib/server/v3-schema.ts](../lib/server/v3-schema.ts) 中自动 bootstrap：

- `v3_waybill_snapshots`：V2 运单只读快照，保存数据来源和同步时间。
- `v3_sync_logs`：跨系统调用日志，包含 request id、接口、入参摘要、状态码、耗时、错误。
- `v3_exception_tickets`：异常工单主表，包含来源、类型、状态、版本号和截止时间。
- `v3_approval_records`：审批/重提/超时/快速放行等审计记录。
- `v3_compensation_records`：赔付记录，含 `direction` 区分客户理赔和供应商追偿。
- `v3_inventory_items` / `v3_inventory_movements`：库存状态和库存变更追踪。
- `v3_scan_records`：扫描记录，保存命中规则和批次锁定状态。
- `v3_quality_rules`：品控规则配置。
- `v3_approval_rules`：分级审批阈值配置。
- `v3_users`：演示角色与权限边界。

旧 V2 导入相关表保留，内置 `/api/v2/*` 仅作为本地 HTTP 适配器使用。

## 4. 技术实现点

- Next.js App Router + TypeScript，首页切换为 [components/v3-workspace.tsx](../components/v3-workspace.tsx)。
- V3 服务层集中在 [lib/server/v3-workflow.ts](../lib/server/v3-workflow.ts)。
- V2 HTTP 客户端集中在 [lib/server/v2-client.ts](../lib/server/v2-client.ts)，统一处理鉴权、超时、重试、request id 和日志。
- 审批并发使用 `version` 前置校验和事务内 `FOR UPDATE` 行锁。
- 幂等性使用审批记录 `idempotency_key` 唯一约束、工单状态前置校验、赔付/库存唯一约束兜底。
- 审批通过后的工单状态、赔付记录、库存变更、扫描批次解锁在 `withClient` 事务内完成。
- 接口异常时，关键创建动作不使用缓存；详情展示允许使用快照并明确标注数据来源。

## 5. 页面与接口落点

页面模块：

- 流程总览：状态概览、接口成功率、双状态机说明。
- 扫描品控：扫描录入、品控规则命中、暂扣/幂等提示。
- 异常工单：手工上报、列表筛选分页、详情审批、快速放行、重提。
- 规则配置：审批阈值和品控阈值可调整。
- 接口监控：V2 同步日志、request id、状态码和错误信息。

主要 V3 API：

- `GET/POST /api/v3/tickets`
- `GET /api/v3/tickets/:ticketId`
- `POST /api/v3/tickets/:ticketId/approve`
- `POST /api/v3/tickets/:ticketId/quick-release`
- `POST /api/v3/tickets/:ticketId/resubmit`
- `POST /api/v3/scans`
- `GET/PUT /api/v3/rules`
- `GET /api/v3/sync-logs`
- `POST /api/v3/maintenance`
- `POST /api/v3/seed`

