# V3 调用 V2 系统间接口文档

## 1. 接口原则

V3 与 V2 独立部署、独立数据库。V3 不连接 V2 数据库，所有运单真实性校验和 SKU 归属校验均通过 HTTP API 完成。

生产环境通过环境变量配置：

- `V2_API_BASE_URL`：真实 V2 API 地址，例如 `https://v2.example.com/api/v1`。
- `V2_API_KEY`：V2 分配给 V3 的 API Key。
- `V2_API_TIMEOUT_MS`：默认 3500。
- `V2_API_RETRY_COUNT`：默认 1。

本仓库是独立 V2 服务提供方，优先暴露版本化接口 `/api/v1/waybills/*` 给 V3 调用，并保留兼容路由 `/api/v2/waybills/*`。V3 本地联调应配置 `V2_API_BASE_URL=http://127.0.0.1:3001/api/v1`。

## 2. 鉴权与链路追踪

请求头：

```http
X-API-Key: <V2_API_KEY>
X-Request-ID: <uuid>
Accept: application/json
```

每次调用都会写入 `v3_sync_logs`：

- request id
- endpoint
- 入参摘要
- response status
- success
- duration ms
- error message
- created at

## 3. 接口列表

### 3.1 获取运单详情

```http
GET /waybills/{waybillNo}
```

用途：

- 手工上报前实时校验运单存在。
- 写入/刷新 `v3_waybill_snapshots`。

响应：

```json
{
  "waybillNo": "WB202607060001",
  "externalCode": "WB202607060001",
  "storeName": "上海门店",
  "recipientName": "张三",
  "recipientPhone": "13800000000",
  "recipientAddress": "上海市...",
  "amount": "128.50",
  "status": "created",
  "tenantId": "default",
  "warehouseId": "WH-SH-01",
  "skus": [
    { "skuCode": "SKU-001", "skuName": "冷链商品", "quantity": 1, "spec": "常规" }
  ],
  "sourceUpdatedAt": "2026-07-06T01:00:00.000Z",
  "etag": "optional-version"
}
```

### 3.2 校验 SKU 归属

```http
GET /waybills/{waybillNo}/skus/{skuCode}
```

用途：

- 扫描录入时校验 SKU 确实属于指定运单。
- 防止扫描无关货物并创建虚假品控工单。

响应：

```json
{
  "exists": true,
  "sku": { "skuCode": "SKU-001", "skuName": "冷链商品", "quantity": 1, "spec": "常规" },
  "waybill": { "...": "同运单详情，可选" }
}
```

### 3.3 查询运单列表

```http
GET /waybills?q=keyword&limit=20
```

用途：

- 初始化或增量同步快照。
- 辅助定位可上报运单。

本次代码提供本地适配器路由，V3 主流程尚未依赖列表接口创建工单。

### 3.4 异常结果回写 V2（预留）

```http
POST /waybills/{waybillNo}/exception-flags
```

用途：

- 通知 V2 该运单存在未关闭异常，避免继续按正常流程处理。

本次未实现回写，设计上建议以 outbox 事件异步推送，失败可重试，不阻塞 V3 审批事务。

## 4. 异常处理策略

- 404 运单不存在：前端提示“运单不存在”，不创建工单。
- 404 SKU 不属于运单：前端提示“SKU 不属于该运单”，不创建扫描记录。
- 401/403 鉴权失败：记录 request id，提示接口鉴权失败。
- 5xx 或网络超时：重试 1 次，仍失败则创建动作失败；列表和详情允许展示本地缓存，并标注缓存时间。
- 所有错误都保留 request id，可在接口监控页面追踪。

## 5. V2 老系统二开策略

如果 V2 原本没有对外接口，建议新增版本化 API，例如 `/api/v1/waybills`，不改动已有导入、查询和数据库访问路径。字段演进遵循：

- 新增字段向后兼容。
- 不删除旧字段，废弃字段至少保留一个版本周期。
- 金额字段以字符串 decimal 返回，避免 JS number 精度问题。
- 响应保留 `sourceUpdatedAt` 或 `etag`，供 V3 判断快照新鲜度。
- 灰度阶段只给 V3 的 API Key 开放，观察日志成功率后再扩大调用方。
