"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Database,
  Download,
  FileSpreadsheet,
  ListChecks,
  Loader2,
  Play,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Route,
} from "lucide-react";
import type { ImportField, ImportRow, ParsedWorkbookSource, ParseRule, ShipmentRecord } from "@/lib/types";
import { EMPTY_IMPORT_VALUES, FIELD_LABELS, IMPORT_FIELDS } from "@/lib/import/constants";
import { exportRowsToWorkbook } from "@/lib/export/xlsx";
import { executeParseRule, readImportFile } from "@/lib/import/parse";
import { validateRows } from "@/lib/import/validation";

type HistoryFilterState = {
  q: string;
  externalCode: string;
  recipientName: string;
  from: string;
  to: string;
};

type ProgressState = {
  current: number;
  total: number;
  label: string;
};

type ApiHistoryResponse = {
  items: ShipmentRecord[];
  total: number;
  page: number;
  pageSize: number;
};

type ParseRuleRecord = {
  id: string;
  name: string;
  description: string;
  fileKind: ParseRule["fileKind"];
  rule: ParseRule;
  aiGenerated: boolean;
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

type ImportTaskView = {
  taskId: string;
  fileName: string;
  sheetName: string;
  status: "pending" | "processing" | "completed" | "partial_success" | "failed";
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  totalBatches: number;
  completedBatches: number;
  traceId: string;
  degraded: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type TaskErrorRecord = {
  id: number;
  unitId: string;
  batchIndex: number;
  rowNumber: number;
  fieldName: string;
  rawValue: string;
  errorCode: string;
  errorReason: string;
  severity: "error" | "warning";
  traceId: string;
  createdAt: string;
};

type TaskBatchRecord = {
  id: string;
  unitId: string;
  batchIndex: number;
  startRow: number;
  endRow: number;
  status: string;
  retryCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  errorMessage: string | null;
};

type MonitorSummary = {
  throughput: Array<{ minute: string; successRows: number }>;
  queueDepth: { batches: number; rows: number; level: "normal" | "warning"; available: boolean };
  stageLatency: Record<string, number | null> | null;
  errorDistribution: Array<{ errorCode: string; errorReason: string; count: number }>;
  slowBatches: Array<{ taskId: string; unitId: string; batchIndex: number; totalDurationMs: number; status: string; traceId: string }>;
  taskStatus: Array<{ status: string; count: number }>;
};

type TraceEventRecord = {
  id: number;
  taskId: string | null;
  unitId: string | null;
  eventName: string;
  eventStatus: string;
  message: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
};

type ActivePage = "import" | "tasks" | "monitor" | "trace" | "query";

function makeEmptyRow(sourceRowNumber = 0): ImportRow {
  return {
    id: crypto.randomUUID(),
    sourceRowNumber,
    values: { ...EMPTY_IMPORT_VALUES },
    issues: [],
  };
}

function compactSource(source: ParsedWorkbookSource): ParsedWorkbookSource {
  return {
    ...source,
    sheets: source.sheets.slice(0, 5).map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.slice(0, 40).map((row) => row.slice(0, 60)),
    })),
  };
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function shouldUseServerExtractor(file: File) {
  const extension = getExtension(file.name);
  return extension === "docx" || extension === "pdf";
}

function mergeDbDuplicates(rows: ImportRow[], duplicates: Record<string, number>) {
  return rows.map((row) => {
    const externalCode = String(row.values.externalCode || "").trim();
    const duplicateCount = externalCode ? duplicates[externalCode] : 0;
    const issues = row.issues.filter((issue) => issue.code !== "external_code_duplicate_db");

    if (duplicateCount) {
      issues.push({
        rowNumber: row.sourceRowNumber,
        field: "externalCode",
        code: "external_code_duplicate_db",
        message: `外部编码已存在历史数据（${duplicateCount} 条）`,
      });
    }

    return {
      ...row,
      duplicateInDb: Boolean(duplicateCount),
      issues,
    };
  });
}

function getIssueText(row: ImportRow, field: ImportField) {
  return row.issues.find((issue) => issue.field === field)?.message || "";
}

function getGlobalIssueText(row: ImportRow) {
  return row.issues.find((issue) => issue.field === "global")?.message || "";
}

function getRuleText(rule: ParseRule) {
  return JSON.stringify(rule, null, 2);
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "等待中",
    processing: "处理中",
    completed: "已完成",
    partial_success: "部分成功",
    failed: "失败",
    queued: "已入队",
  };
  return labels[status] || status;
}

function statusTone(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial_success" || status === "queued" || status === "processing") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function formatDateTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}

function formatLatency(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? `${Math.round(number)} ms` : "-";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload as T;
}

async function extractSourceOnServer(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/import-source", {
    method: "POST",
    body: formData,
  });
  const payload = (await response.json().catch(() => ({}))) as { source?: ParsedWorkbookSource; error?: string };
  if (!response.ok || !payload.source) {
    throw new Error(payload.error || "服务端文本提取失败");
  }
  return payload.source;
}

export function ImportWorkspace() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [source, setSource] = useState<ParsedWorkbookSource | null>(null);
  const [ruleRecords, setRuleRecords] = useState<ParseRuleRecord[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [ruleDraft, setRuleDraft] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [duplicates, setDuplicates] = useState<Record<string, number>>({});
  const [message, setMessage] = useState("");
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isSavingRule, setIsSavingRule] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [parseProgress, setParseProgress] = useState<ProgressState>({ current: 0, total: 0, label: "" });
  const [submitProgress, setSubmitProgress] = useState<ProgressState>({ current: 0, total: 0, label: "" });
  const [submitSummary, setSubmitSummary] = useState<{ success: number; failure: number } | null>(null);
  const [history, setHistory] = useState<ApiHistoryResponse>({ items: [], total: 0, page: 1, pageSize: 10 });
  const [filters, setFilters] = useState<HistoryFilterState>({
    q: "",
    externalCode: "",
    recipientName: "",
    from: "",
    to: "",
  });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const [activePage, setActivePage] = useState<ActivePage>("import");
  const [tasks, setTasks] = useState<ImportTaskView[]>([]);
  const [activeTaskId, setActiveTaskId] = useState("");
  const [activeTask, setActiveTask] = useState<ImportTaskView | null>(null);
  const [taskErrors, setTaskErrors] = useState<{ items: TaskErrorRecord[]; total: number; page: number; pageSize: number }>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  const [taskBatches, setTaskBatches] = useState<TaskBatchRecord[]>([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const [monitorSummary, setMonitorSummary] = useState<MonitorSummary | null>(null);
  const [monitorLoading, setMonitorLoading] = useState(false);
  const [errorBatchFilter, setErrorBatchFilter] = useState("");
  const [errorCodeFilter, setErrorCodeFilter] = useState("");
  const [traceIdInput, setTraceIdInput] = useState("");
  const [traceEvents, setTraceEvents] = useState<TraceEventRecord[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);

  const validRowCount = useMemo(() => rows.filter((row) => row.issues.length === 0).length, [rows]);
  const invalidRowCount = rows.length - validRowCount;
  const allIssues = useMemo(() => rows.flatMap((row) => row.issues), [rows]);
  const previewPageSize = 100;
  const previewRows = rows.slice((previewPage - 1) * previewPageSize, previewPage * previewPageSize);
  const previewPageCount = Math.max(1, Math.ceil(rows.length / previewPageSize));

  useEffect(() => {
    void loadRules();
    void loadHistory(1);
    void loadTasks();
  }, []);

  useEffect(() => {
    if (activePage === "tasks") void loadTasks();
    if (activePage === "monitor") void loadMonitor();
  }, [activePage]);

  useEffect(() => {
    if (!activeTaskId) return;
    let stopped = false;

    async function refresh() {
      if (stopped) return;
      await loadTaskDetail(activeTaskId, true);
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeTaskId]);

  async function loadRules() {
    try {
      const payload = await fetchJson<{ rules: ParseRuleRecord[] }>("/api/parse-rules");
      setRuleRecords(payload.rules);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载解析规则失败");
    }
  }

  async function loadHistory(page: number) {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(history.pageSize),
        q: filters.q,
        externalCode: filters.externalCode,
        recipientName: filters.recipientName,
        from: filters.from,
        to: filters.to,
      });
      const payload = await fetchJson<ApiHistoryResponse>(`/api/shipments?${params.toString()}`);
      setHistory(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载历史运单失败");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadTasks() {
    try {
      const payload = await fetchJson<{ tasks: ImportTaskView[] }>("/api/import-tasks?limit=30");
      setTasks(payload.tasks);
      if (!activeTaskId && payload.tasks[0]) {
        setActiveTask(payload.tasks[0]);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载导入任务失败");
    }
  }

  async function loadTaskDetail(taskId: string, runWorker = false) {
    if (!taskId) return;
    setTaskLoading(true);
    try {
      if (runWorker) {
        await fetchJson("/api/import-worker/tick", {
          method: "POST",
          body: JSON.stringify({ workerLimit: 2, dispatchLimit: 20 }),
        }).catch(() => null);
      }

      const errorParams = new URLSearchParams({ page: "1", page_size: "50" });
      if (errorBatchFilter) errorParams.set("batch", errorBatchFilter);
      if (errorCodeFilter) errorParams.set("error_code", errorCodeFilter);

      const [taskPayload, errorPayload, batchPayload] = await Promise.all([
        fetchJson<{ task: ImportTaskView }>(`/api/import-tasks/${taskId}`),
        fetchJson<{ items: TaskErrorRecord[]; total: number; page: number; pageSize: number }>(`/api/import-tasks/${taskId}/errors?${errorParams.toString()}`),
        fetchJson<{ batches: TaskBatchRecord[] }>(`/api/import-tasks/${taskId}/batches`),
      ]);

      setActiveTask(taskPayload.task);
      setTraceIdInput(taskPayload.task.traceId);
      setTaskErrors(errorPayload);
      setTaskBatches(batchPayload.batches);
      setSubmitProgress({
        current: taskPayload.task.processedRows,
        total: taskPayload.task.totalRows,
        label: `${taskPayload.task.status} ${taskPayload.task.processedRows}/${taskPayload.task.totalRows}`,
      });
      if (["completed", "partial_success", "failed"].includes(taskPayload.task.status)) {
        setSubmitSummary({ success: taskPayload.task.successRows, failure: taskPayload.task.failedRows });
        await loadHistory(1);
      }
      await loadTasks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载任务详情失败");
    } finally {
      setTaskLoading(false);
    }
  }

  async function reloadTaskErrors(page = 1) {
    const taskId = activeTaskId || activeTask?.taskId || "";
    if (!taskId) return;
    try {
      const params = new URLSearchParams({ page: String(page), page_size: "50" });
      if (errorBatchFilter) params.set("batch", errorBatchFilter);
      if (errorCodeFilter) params.set("error_code", errorCodeFilter);
      const payload = await fetchJson<{ items: TaskErrorRecord[]; total: number; page: number; pageSize: number }>(`/api/import-tasks/${taskId}/errors?${params.toString()}`);
      setTaskErrors(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载错误明细失败");
    }
  }

  async function loadMonitor() {
    setMonitorLoading(true);
    try {
      const payload = await fetchJson<MonitorSummary>("/api/import-monitor/summary");
      setMonitorSummary(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载导入监控失败");
    } finally {
      setMonitorLoading(false);
    }
  }

  async function handleTraceSearch() {
    const traceId = traceIdInput.trim() || activeTask?.traceId || "";
    if (!traceId) {
      setMessage("请输入 trace_id。");
      return;
    }

    setTraceLoading(true);
    try {
      const payload = await fetchJson<{ events: TraceEventRecord[] }>(`/api/traces/${encodeURIComponent(traceId)}`);
      setTraceEvents(payload.events);
      setActivePage("trace");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trace 查询失败");
    } finally {
      setTraceLoading(false);
    }
  }

  async function syncDbDuplicates(nextRows: ImportRow[]) {
    const codes = unique(nextRows.map((row) => String(row.values.externalCode || "").trim()));
    if (!codes.length) {
      setDuplicates({});
      return {};
    }

    const payload = await fetchJson<{ duplicates: Record<string, number> }>("/api/shipments/check-duplicates", {
      method: "POST",
      body: JSON.stringify({ codes }),
    });
    setDuplicates(payload.duplicates);
    return payload.duplicates;
  }

  function parseRuleFromDraft() {
    const parsed = JSON.parse(ruleDraft) as ParseRule;
    if (!parsed.name || !parsed.kind || !parsed.fileKind) {
      throw new Error("规则 JSON 缺少 name/kind/fileKind");
    }
    return parsed;
  }

  async function handleFile(file: File) {
    setIsLoadingFile(true);
    setMessage("");
    setRows([]);
    setSubmitSummary(null);
    setParseProgress({ current: 0, total: 0, label: "" });
    try {
      const parsedSource = shouldUseServerExtractor(file)
        ? await extractSourceOnServer(file)
        : await readImportFile(file);
      setSource(parsedSource);
      setMessage(`${file.name} 已读取${parsedSource.textContent ? `，提取文本 ${parsedSource.textContent.length} 字符` : ""}，需手动选择已有规则或新建规则后试解析。`);
    } catch (error) {
      setSource(null);
      setMessage(error instanceof Error ? error.message : "读取文件失败");
    } finally {
      setIsLoadingFile(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await handleFile(file);
    event.target.value = "";
  }

  async function handleGenerateRule() {
    if (!source) {
      setMessage("请先上传文件。");
      return;
    }

    setIsGenerating(true);
    setMessage("");
    try {
      const payload = await fetchJson<{ rule: ParseRule; source: "llm" | "heuristic" }>("/api/parse-rules/generate", {
        method: "POST",
        body: JSON.stringify({ source: compactSource(source) }),
      });
      setSelectedRuleId("");
      setRuleDraft(getRuleText(payload.rule));
      setMessage(payload.source === "llm" ? "AI 已生成推荐规则，请试解析并确认。" : "已生成本地推荐规则，请试解析并确认。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成规则失败");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleSaveRule() {
    setIsSavingRule(true);
    setMessage("");
    try {
      const rule = parseRuleFromDraft();
      const payload = await fetchJson<{ rule: ParseRuleRecord }>("/api/parse-rules", {
        method: "POST",
        body: JSON.stringify({ id: selectedRuleId || rule.id, rule }),
      });
      setSelectedRuleId(payload.rule.id);
      setRuleDraft(getRuleText(payload.rule.rule));
      await loadRules();
      setMessage("解析规则已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存规则失败");
    } finally {
      setIsSavingRule(false);
    }
  }

  async function handleDeleteRule() {
    if (!selectedRuleId) return;
    setMessage("");
    try {
      await fetchJson(`/api/parse-rules/${selectedRuleId}`, { method: "DELETE" });
      setSelectedRuleId("");
      setRuleDraft("");
      await loadRules();
      setMessage("解析规则已删除。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除规则失败");
    }
  }

  async function handleParsePreview() {
    if (!source) {
      setMessage("请先上传文件。");
      return;
    }

    setIsParsing(true);
    setMessage("");
    setPreviewPage(1);
    setParseProgress({ current: 0, total: 0, label: "" });
    try {
      const rule = parseRuleFromDraft();
      const parsedRows = await executeParseRule(source, rule, (current, total) => {
        setParseProgress({ current, total, label: `解析 ${current}/${total}` });
      });
      const deduped = await syncDbDuplicates(parsedRows);
      setRows(mergeDbDuplicates(parsedRows, deduped));
      setMessage(`试解析完成：${parsedRows.length} 行，错误 ${parsedRows.filter((row) => row.issues.length > 0).length} 行。`);
    } catch (error) {
      setRows([]);
      setMessage(error instanceof Error ? error.message : "试解析失败");
    } finally {
      setIsParsing(false);
    }
  }

  function handleSelectRule(ruleId: string) {
    setSelectedRuleId(ruleId);
    const record = ruleRecords.find((rule) => rule.id === ruleId);
    setRuleDraft(record ? getRuleText(record.rule) : "");
  }

  function updateRow(rowId: string, field: ImportField, value: string) {
    const nextRows = rows.map((row) =>
      row.id === rowId
        ? {
            ...row,
            values: {
              ...row.values,
              [field]: value,
            },
          }
        : row
    );
    const validated = validateRows(nextRows.map((row) => ({ ...row, issues: [] })));
    setRows(mergeDbDuplicates(validated, duplicates));
    void syncDbDuplicates(validated).then((map) => setRows(mergeDbDuplicates(validated, map)));
  }

  function addBlankRow() {
    const nextSourceRow = rows.length ? Math.max(...rows.map((row) => row.sourceRowNumber)) + 1 : 1;
    const nextRows = [...rows, makeEmptyRow(nextSourceRow)];
    const validated = validateRows(nextRows.map((row) => ({ ...row, issues: [] })));
    setRows(mergeDbDuplicates(validated, duplicates));
  }

  function removeRow(rowId: string) {
    const nextRows = rows.filter((row) => row.id !== rowId);
    const validated = validateRows(nextRows.map((row) => ({ ...row, issues: [] })));
    setRows(mergeDbDuplicates(validated, duplicates));
  }

  async function handleExport() {
    await exportRowsToWorkbook(rows, source?.fileName ? `${source.fileName.replace(/\.(xlsx|xls|docx|pdf)$/i, "")}-preview.xlsx` : "import-preview.xlsx");
  }

  async function handleSubmit() {
    if (rows.length === 0) {
      setMessage("请先试解析数据。");
      return;
    }

    setIsSubmitting(true);
    setMessage("");
    setSubmitSummary(null);
    try {
      const rule = parseRuleFromDraft();
      const payload = await fetchJson<{ task: ImportTaskView; task_id: string; trace_id: string }>("/api/import-tasks", {
        method: "POST",
        body: JSON.stringify({
          fileName: source?.fileName || "import.xlsx",
          sheetName: source?.sheets.map((sheet) => sheet.name).join(", ") || source?.fileKind || "-",
          ruleId: selectedRuleId || rule.id,
          rule,
          rows,
          batchSize: 1000,
          duplicatePolicy: "allow_new_task",
        }),
      });

      setActiveTaskId(payload.task_id);
      setActiveTask(payload.task);
      setTraceIdInput(payload.trace_id);
      setSubmitProgress({ current: 0, total: payload.task.totalRows, label: "任务已创建，等待 Worker 处理" });
      setMessage(`异步导入任务已创建：${payload.task_id}`);
      setActivePage("tasks");
      await loadTasks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败");
    } finally {
      setIsSubmitting(false);
    }
  }

  function renderTasksPage() {
    const progressTotal = activeTask?.totalRows || 0;
    const progressCurrent = activeTask?.processedRows || 0;

    return (
      <section className="grid gap-4 xl:grid-cols-[340px_1fr]">
        <Panel>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-[var(--muted)]">Import Tasks</p>
              <h1 className="mt-1 text-xl font-semibold">异步导入任务</h1>
            </div>
            <button type="button" onClick={() => void loadTasks()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold">
              <Activity className="h-4 w-4" />
              刷新
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {tasks.length ? (
              tasks.map((task) => (
                <button
                  type="button"
                  key={task.taskId}
                  onClick={() => {
                    setActiveTaskId(task.taskId);
                    setActiveTask(task);
                    setTraceIdInput(task.traceId);
                    void loadTaskDetail(task.taskId);
                  }}
                  className={`w-full rounded-md border px-3 py-3 text-left ${activeTask?.taskId === task.taskId ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)] bg-white hover:border-[var(--line-strong)]"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{task.fileName}</span>
                    <span className={`shrink-0 rounded border px-2 py-0.5 text-xs font-semibold ${statusTone(task.status)}`}>{statusLabel(task.status)}</span>
                  </div>
                  <div className="mt-2 text-xs text-[var(--muted)]">
                    {task.processedRows}/{task.totalRows} 行 · {task.completedBatches}/{task.totalBatches} 批
                  </div>
                </button>
              ))
            ) : (
              <div className="rounded-md border border-[var(--line)] bg-slate-50 px-4 py-8 text-center text-sm text-[var(--muted)]">暂无任务</div>
            )}
          </div>
        </Panel>

        <div className="grid gap-4">
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase text-[var(--muted)]">Task Detail</p>
                <h2 className="mt-1 text-xl font-semibold">{activeTask?.fileName || "未选择任务"}</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!activeTaskId || taskLoading}
                  onClick={() => void loadTaskDetail(activeTaskId, true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  {taskLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
                  Worker Tick
                </button>
                <button
                  type="button"
                  disabled={!activeTask?.traceId}
                  onClick={() => void handleTraceSearch()}
                  className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  <Route className="h-4 w-4" />
                  Trace
                </button>
              </div>
            </div>

            {activeTask ? (
              <>
                <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                  <SummaryLine label="task_id" value={activeTask.taskId} />
                  <SummaryLine label="trace_id" value={activeTask.traceId} />
                  <SummaryLine label="状态" value={statusLabel(activeTask.status)} />
                  <SummaryLine label="总行数" value={String(activeTask.totalRows)} />
                  <SummaryLine label="成功行" value={String(activeTask.successRows)} />
                  <SummaryLine label="失败行" value={String(activeTask.failedRows)} />
                </div>
                <div className="mt-4 rounded-lg border border-[var(--line)] bg-white p-4">
                  <ProgressBar label={`${activeTask.completedBatches}/${activeTask.totalBatches} 批完成`} current={progressCurrent} total={progressTotal} />
                </div>
                {activeTask.degraded ? (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>SKU 校验已降级：本次导入未经过商品主数据完整校验，数据可能需要后续复核。</span>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-4 rounded-md border border-[var(--line)] bg-slate-50 px-4 py-10 text-center text-sm text-[var(--muted)]">选择左侧任务查看进度</div>
            )}
          </Panel>

          {activeTask ? (
            <section className="grid gap-4 2xl:grid-cols-[1fr_0.9fr]">
              <Panel>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold">错误明细</h2>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={errorBatchFilter}
                      onChange={(event) => setErrorBatchFilter(event.target.value)}
                      className="h-9 w-24 rounded border border-[var(--line)] px-2 text-sm outline-none"
                      placeholder="批次"
                    />
                    <select
                      value={errorCodeFilter}
                      onChange={(event) => setErrorCodeFilter(event.target.value)}
                      className="h-9 rounded border border-[var(--line)] bg-white px-2 text-sm outline-none"
                    >
                      <option value="">全部错误码</option>
                      {["E001", "E002", "E003", "E004", "E005", "E006", "E007", "E008", "W001"].map((code) => (
                        <option key={code} value={code}>{code}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void reloadTaskErrors(1)} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold">
                      <Search className="h-4 w-4" />
                      筛选
                    </button>
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
                  <table className="min-w-[980px] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        <Th>级别</Th>
                        <Th>批次</Th>
                        <Th>行号</Th>
                        <Th>字段</Th>
                        <Th>原始值</Th>
                        <Th>错误码</Th>
                        <Th>原因</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskErrors.items.length ? (
                        taskErrors.items.map((item) => (
                          <tr key={item.id} className={item.severity === "warning" ? "bg-amber-50" : "odd:bg-white even:bg-slate-50/60"}>
                            <Td>{item.severity === "warning" ? "warning" : "error"}</Td>
                            <Td>{item.batchIndex}</Td>
                            <Td>{item.rowNumber}</Td>
                            <Td>{item.fieldName}</Td>
                            <Td>{item.rawValue || "-"}</Td>
                            <Td>{item.errorCode}</Td>
                            <Td>{item.errorReason}</Td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={7} className="px-6 py-10 text-center text-sm text-[var(--muted)]">暂无错误</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <Panel>
                <h2 className="text-xl font-semibold">批次状态</h2>
                <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
                  <table className="min-w-[760px] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        <Th>批次</Th>
                        <Th>状态</Th>
                        <Th>行范围</Th>
                        <Th>成功</Th>
                        <Th>失败</Th>
                        <Th>重试</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskBatches.length ? (
                        taskBatches.map((batch) => (
                          <tr key={batch.id} className="odd:bg-white even:bg-slate-50/60">
                            <Td>{batch.unitId}</Td>
                            <Td><span className={`rounded border px-2 py-0.5 text-xs font-semibold ${statusTone(batch.status)}`}>{statusLabel(batch.status)}</span></Td>
                            <Td>{batch.startRow}-{batch.endRow}</Td>
                            <Td>{batch.successCount}</Td>
                            <Td>{batch.failureCount}</Td>
                            <Td>{batch.retryCount}</Td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="px-6 py-10 text-center text-sm text-[var(--muted)]">暂无批次</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </section>
          ) : null}
        </div>
      </section>
    );
  }

  function renderMonitorPage() {
    const maxThroughput = Math.max(1, ...(monitorSummary?.throughput.map((item) => item.successRows) || [1]));
    const latency: Record<string, number | null | undefined> = monitorSummary?.stageLatency || {};

    return (
      <div className="grid gap-4">
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-[var(--muted)]">Import Monitor</p>
              <h1 className="mt-1 text-xl font-semibold">导入监控</h1>
            </div>
            <button type="button" onClick={() => void loadMonitor()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold">
              {monitorLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
              刷新
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <StatCard icon={<Activity className="h-4 w-4" />} title="队列批次" value={String(monitorSummary?.queueDepth.batches ?? 0)} />
            <StatCard icon={<ListChecks className="h-4 w-4" />} title="积压行数" value={String(monitorSummary?.queueDepth.rows ?? 0)} />
            <StatCard icon={<Database className="h-4 w-4" />} title="队列状态" value={monitorSummary?.queueDepth.level === "warning" ? "预警" : "正常"} />
            <StatCard icon={<AlertTriangle className="h-4 w-4" />} title="错误类型" value={String(monitorSummary?.errorDistribution.length ?? 0)} />
          </div>
        </Panel>

        <section className="grid gap-4 xl:grid-cols-2">
          <Panel>
            <h2 className="text-xl font-semibold">实时吞吐量</h2>
            <div className="mt-4 space-y-3">
              {(monitorSummary?.throughput.length ? monitorSummary.throughput : [{ minute: "-", successRows: 0 }]).map((item) => (
                <div key={item.minute} className="grid grid-cols-[64px_1fr_80px] items-center gap-3 text-sm">
                  <span className="text-[var(--muted)]">{item.minute}</span>
                  <span className="h-3 overflow-hidden rounded-full bg-slate-100">
                    <span className="block h-full bg-[var(--accent)]" style={{ width: `${Math.max(4, (item.successRows / maxThroughput) * 100)}%` }} />
                  </span>
                  <span className="text-right font-semibold">{item.successRows}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <h2 className="text-xl font-semibold">阶段耗时分布</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <SummaryLine label="解析 P95" value={formatLatency(latency.parse_p95)} />
              <SummaryLine label="规则 P95" value={formatLatency(latency.rule_p95)} />
              <SummaryLine label="校验 P95" value={formatLatency(latency.validate_p95)} />
              <SummaryLine label="写入 P95" value={formatLatency(latency.insert_p95)} />
              <SummaryLine label="解析 P99" value={formatLatency(latency.parse_p99)} />
              <SummaryLine label="写入 P99" value={formatLatency(latency.insert_p99)} />
            </div>
          </Panel>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <Panel>
            <h2 className="text-xl font-semibold">错误类型分布</h2>
            <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
              <table className="min-w-[540px] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <Th>错误码</Th>
                    <Th>原因</Th>
                    <Th>数量</Th>
                  </tr>
                </thead>
                <tbody>
                  {monitorSummary?.errorDistribution.length ? (
                    monitorSummary.errorDistribution.map((item) => (
                      <tr key={item.errorCode} className="odd:bg-white even:bg-slate-50/60">
                        <Td>{item.errorCode}</Td>
                        <Td>{item.errorReason}</Td>
                        <Td>{item.count}</Td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="px-6 py-10 text-center text-sm text-[var(--muted)]">暂无错误</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <h2 className="text-xl font-semibold">慢批次 TOP 10</h2>
            <div className="mt-4 space-y-2">
              {(monitorSummary?.slowBatches || []).map((batch) => (
                <button
                  type="button"
                  key={`${batch.taskId}-${batch.unitId}`}
                  onClick={() => {
                    setActiveTaskId(batch.taskId);
                    setTraceIdInput(batch.traceId);
                    setActivePage("tasks");
                  }}
                  className="grid w-full grid-cols-[96px_1fr_96px] items-center gap-3 rounded-md border border-[var(--line)] bg-white px-3 py-2 text-left text-sm"
                >
                  <span className="font-semibold">{batch.unitId}</span>
                  <span className="truncate text-[var(--muted)]">{batch.taskId}</span>
                  <span className="text-right font-semibold">{batch.totalDurationMs} ms</span>
                </button>
              ))}
              {!monitorSummary?.slowBatches.length ? <div className="rounded-md border border-[var(--line)] bg-slate-50 px-4 py-8 text-center text-sm text-[var(--muted)]">暂无批次日志</div> : null}
            </div>
          </Panel>
        </section>
      </div>
    );
  }

  function renderTracePage() {
    return (
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-[var(--muted)]">Trace Search</p>
            <h1 className="mt-1 text-xl font-semibold">链路检索</h1>
          </div>
          <div className="flex min-w-0 flex-1 justify-end gap-2">
            <input
              value={traceIdInput}
              onChange={(event) => setTraceIdInput(event.target.value)}
              className="h-9 min-w-0 max-w-[520px] flex-1 rounded border border-[var(--line)] px-3 text-sm outline-none"
              placeholder="trace_id"
            />
            <button type="button" onClick={() => void handleTraceSearch()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold">
              {traceLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              查询
            </button>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {traceEvents.length ? (
            traceEvents.map((event) => (
              <div key={event.id} className="rounded-md border border-[var(--line)] bg-white px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${statusTone(event.eventStatus)}`}>{event.eventStatus}</span>
                    <span className="font-semibold">{event.eventName}</span>
                  </div>
                  <span className="text-xs text-[var(--muted)]">{formatDateTime(event.occurredAt)}</span>
                </div>
                <p className="mt-2 text-sm text-slate-700">{event.message || "-"}</p>
                <div className="mt-2 grid gap-2 text-xs text-[var(--muted)] md:grid-cols-3">
                  <span>task_id: {event.taskId || "-"}</span>
                  <span>unit_id: {event.unitId || "-"}</span>
                  <span className="truncate">metadata: {JSON.stringify(event.metadata)}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-md border border-[var(--line)] bg-slate-50 px-4 py-10 text-center text-sm text-[var(--muted)]">暂无 Trace 事件</div>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--workspace)] text-[var(--text)]">
      <TopBar />
      <div className="flex min-h-[calc(100vh-64px)]">
        <SideNav activePage={activePage} onChange={setActivePage} />
        <section className="min-w-0 flex-1">
          <div className="flex w-full flex-col gap-4 p-4">
            {activePage === "import" ? (
              <>
                <section className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
                  <Panel>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase text-[var(--muted)]">Waybill Import</p>
                        <h1 className="mt-1 text-xl font-semibold tracking-normal text-[var(--text)]">运单智能导入</h1>
                      </div>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isLoadingFile}
                        className="inline-flex h-9 items-center gap-2 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[var(--accent-dark)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isLoadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        上传文件
                      </button>
                    </div>

                    <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.docx,.pdf" hidden onChange={handleFileChange} />

                    <label
                      className="mt-4 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded border border-dashed border-[var(--line-strong)] bg-[#fbfdff] p-4 text-center hover:border-[var(--accent)]"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const file = event.dataTransfer.files?.[0];
                        if (file) void handleFile(file);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-7 w-7 text-[var(--accent)]" />
                      <div>
                        <p className="font-semibold">拖拽或点击选择 Excel / Word / PDF</p>
                        <p className="mt-1 text-sm text-[var(--muted)]">{source?.fileName || "未选择文件"}</p>
                      </div>
                    </label>

                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      <StatCard icon={<FileSpreadsheet className="h-4 w-4" />} title="文件类型" value={source?.fileKind.toUpperCase() || "-"} />
                      <StatCard icon={<ListChecks className="h-4 w-4" />} title="预览行" value={String(rows.length)} />
                      <StatCard icon={<Database className="h-4 w-4" />} title="错误行" value={String(invalidRowCount)} />
                    </div>
                  </Panel>

                  <Panel>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase text-[var(--muted)]">Rule</p>
                        <h2 className="mt-2 text-xl font-semibold">解析规则</h2>
                      </div>
                      <button
                        type="button"
                        onClick={handleGenerateRule}
                        disabled={!source || isGenerating}
                        className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                        新建规则
                      </button>
                    </div>

                    <div className="mt-4 grid gap-3">
                      <label className="grid gap-2 text-sm">
                        <span className="text-[var(--muted)]">已保存规则</span>
                        <select
                          value={selectedRuleId}
                          onChange={(event) => handleSelectRule(event.target.value)}
                          className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 outline-none"
                        >
                          <option value="">不选择，编辑新规则</option>
                          {ruleRecords.map((record) => (
                            <option key={record.id} value={record.id}>
                              {record.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleParsePreview}
                          disabled={!source || !ruleDraft || isParsing}
                          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isParsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                          试解析
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveRule}
                          disabled={!ruleDraft || isSavingRule}
                          className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isSavingRule ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                          保存规则
                        </button>
                        <button
                          type="button"
                          onClick={handleDeleteRule}
                          disabled={!selectedRuleId}
                          className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <Trash2 className="h-4 w-4" />
                          删除规则
                        </button>
                      </div>
                    </div>
                  </Panel>
                </section>

                <section className="grid gap-4 xl:grid-cols-[0.82fr_1.18fr]">
                  <Panel>
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-xl font-semibold">规则 JSON</h2>
                      <span className="text-sm text-[var(--muted)]">{selectedRuleId ? "编辑已保存规则" : "新规则草稿"}</span>
                    </div>
                    <textarea
                      value={ruleDraft}
                      onChange={(event) => setRuleDraft(event.target.value)}
                      spellCheck={false}
                      className="mt-4 h-[410px] w-full resize-none rounded-lg border border-[var(--line)] bg-slate-950 px-4 py-3 font-mono text-xs leading-5 text-slate-100 outline-none"
                      placeholder="上传文件后点击新建规则，或选择已保存规则。"
                    />
                    {(isParsing || parseProgress.total > 0) && (
                      <div className="mt-4 rounded-lg border border-[var(--line)] bg-white p-3">
                        <ProgressBar label={parseProgress.label} current={parseProgress.current} total={parseProgress.total} />
                      </div>
                    )}
                    {message ? <p className="mt-4 rounded-lg bg-[var(--accent-soft)] px-4 py-3 text-sm leading-6 text-[var(--accent)]">{message}</p> : null}
                  </Panel>

                  <Panel>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="text-xl font-semibold">数据预览</h2>
                        <p className="mt-1 text-sm text-[var(--muted)]">有效 {validRowCount} 行 / 错误 {invalidRowCount} 行</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={addBlankRow} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold">
                          <Plus className="h-4 w-4" />
                          新增空行
                        </button>
                        <button type="button" onClick={handleExport} disabled={!rows.length} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60">
                          <Download className="h-4 w-4" />
                          导出
                        </button>
                        <button type="button" onClick={handleSubmit} disabled={!rows.length || isSubmitting} className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">
                          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                          提交下单
                        </button>
                      </div>
                    </div>

                    {allIssues.length ? (
                      <div className="mt-4 max-h-28 overflow-auto rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                        {allIssues.map((issue, index) => (
                          <p key={`${issue.rowNumber}-${issue.code}-${index}`}>
                            第 {issue.rowNumber} 行 / {issue.field === "global" ? "整行" : FIELD_LABELS[issue.field]}：{issue.message}
                          </p>
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
                      <table className="min-w-[1280px] border-separate border-spacing-0 text-sm">
                        <thead>
                          <tr>
                            <Th>行号</Th>
                            {IMPORT_FIELDS.map((field) => (
                              <Th key={field}>{FIELD_LABELS[field]}</Th>
                            ))}
                            <Th>操作</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.length ? (
                            previewRows.map((row, index) => (
                              <tr key={row.id} className={row.issues.length ? "bg-rose-50" : index % 2 === 0 ? "bg-white" : "bg-slate-50/60"}>
                                <Td className="w-20 text-center font-semibold">{row.sourceRowNumber}</Td>
                                {IMPORT_FIELDS.map((field) => {
                                  const issue = getIssueText(row, field);
                                  return (
                                    <Td key={field} className={issue ? "bg-rose-50" : ""}>
                                      <input
                                        value={row.values[field] ?? ""}
                                        onChange={(event) => updateRow(row.id, field, event.target.value)}
                                        className={`w-full rounded-md border px-2 py-1.5 outline-none ${issue ? "border-rose-400" : "border-[var(--line)]"}`}
                                      />
                                      {issue ? <p className="mt-1 text-xs text-rose-600">{issue}</p> : null}
                                    </Td>
                                  );
                                })}
                                <Td>
                                  <button type="button" onClick={() => removeRow(row.id)} className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] px-2 py-1 text-xs font-semibold">
                                    <Trash2 className="h-3.5 w-3.5" />
                                    删除
                                  </button>
                                  {getGlobalIssueText(row) ? <p className="mt-1 text-xs text-rose-600">{getGlobalIssueText(row)}</p> : null}
                                </Td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={IMPORT_FIELDS.length + 2} className="px-6 py-12 text-center text-sm text-[var(--muted)]">
                                暂无预览数据。
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--muted)]">
                      <span>
                        第 {previewPage} / {previewPageCount} 页，每页 {previewPageSize} 行
                      </span>
                      <div className="flex gap-2">
                        <button type="button" disabled={previewPage <= 1} onClick={() => setPreviewPage((page) => Math.max(1, page - 1))} className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 disabled:opacity-50">
                          上一页
                        </button>
                        <button type="button" disabled={previewPage >= previewPageCount} onClick={() => setPreviewPage((page) => Math.min(previewPageCount, page + 1))} className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 disabled:opacity-50">
                          下一页
                        </button>
                      </div>
                    </div>
                  </Panel>
                </section>

                <Panel>
                  <h2 className="text-xl font-semibold">导入状态</h2>
                  <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <SummaryLine label="文件名" value={source?.fileName || "-"} />
                    <SummaryLine label="Sheet" value={source?.sheets.map((sheet) => sheet.name).join(" / ") || "-"} />
                    <SummaryLine label="规则" value={ruleDraft ? "已配置" : "-"} />
                    <SummaryLine label="总行数" value={String(rows.length)} />
                    <SummaryLine label="有效行" value={String(validRowCount)} />
                    <SummaryLine label="错误行" value={String(invalidRowCount)} />
                  </div>

                  <div className="mt-4 rounded-lg border border-[var(--line)] bg-white p-4">
                    <div className="flex items-center justify-between text-sm">
                      <span>提交结果</span>
                      <span className="font-semibold text-[var(--accent)]">{submitSummary ? `${submitSummary.success} 成功 / ${submitSummary.failure} 失败` : "-"}</span>
                    </div>
                    <div className="mt-3">
                      <ProgressBar label={submitProgress.label} current={submitProgress.current} total={submitProgress.total} />
                    </div>
                  </div>
                </Panel>
              </>
            ) : activePage === "tasks" ? (
              renderTasksPage()
            ) : activePage === "monitor" ? (
              renderMonitorPage()
            ) : activePage === "trace" ? (
              renderTracePage()
            ) : (
              <Panel>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase text-[var(--muted)]">Waybill Search</p>
                    <h1 className="mt-1 text-xl font-semibold">导入运单查询</h1>
                  </div>
                  <button type="button" onClick={() => void loadHistory(1)} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold">
                    <Search className="h-4 w-4" />
                    查询
                  </button>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  <InputField label="关键字" value={filters.q} onChange={(value) => setFilters((prev) => ({ ...prev, q: value }))} />
                  <InputField label="外部编码" value={filters.externalCode} onChange={(value) => setFilters((prev) => ({ ...prev, externalCode: value }))} />
                  <InputField label="收件人/门店" value={filters.recipientName} onChange={(value) => setFilters((prev) => ({ ...prev, recipientName: value }))} />
                  <InputField label="开始时间" value={filters.from} type="datetime-local" onChange={(value) => setFilters((prev) => ({ ...prev, from: value }))} />
                  <InputField label="结束时间" value={filters.to} type="datetime-local" onChange={(value) => setFilters((prev) => ({ ...prev, to: value }))} />
                </div>

                <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
                  <table className="min-w-[960px] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        <Th>外部编码</Th>
                        <Th>收货门店/收件人</Th>
                        <Th>SKU</Th>
                        <Th>数量</Th>
                        <Th>提交时间</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyLoading ? (
                        <tr>
                          <td colSpan={5} className="px-6 py-10 text-center text-sm text-[var(--muted)]">
                            加载中...
                          </td>
                        </tr>
                      ) : history.items.length ? (
                        history.items.map((item) => (
                          <tr key={item.id} className="odd:bg-white even:bg-slate-50/60">
                            <Td>{item.externalCode || "-"}</Td>
                            <Td>{item.storeName || item.recipientName || "-"}</Td>
                            <Td>{item.skuName}</Td>
                            <Td>{item.skuQuantity}</Td>
                            <Td>{new Date(item.createdAt).toLocaleString("zh-CN")}</Td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="px-6 py-10 text-center text-sm text-[var(--muted)]">
                            暂无历史运单。
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 flex items-center justify-between text-sm text-[var(--muted)]">
                  <p>
                    共 {history.total} 条，当前第 {history.page} 页
                  </p>
                  <div className="flex gap-2">
                    <button type="button" disabled={history.page <= 1 || historyLoading} onClick={() => void loadHistory(history.page - 1)} className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 disabled:opacity-50">
                      上一页
                    </button>
                    <button type="button" disabled={history.page * history.pageSize >= history.total || historyLoading} onClick={() => void loadHistory(history.page + 1)} className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 disabled:opacity-50">
                      下一页
                    </button>
                  </div>
                </div>
              </Panel>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function TopBar() {
  return (
    <header className="flex h-16 items-center bg-[linear-gradient(100deg,var(--topbar-start),var(--topbar-end))] text-white">
      <div className="flex h-full w-60 shrink-0 items-center gap-2 px-5">
        <div className="text-4xl font-black italic leading-none tracking-normal">ZT</div>
        <div className="leading-tight">
          <div className="text-lg font-bold">中通冷链</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] opacity-90">ZTO COLD CHAIN</div>
        </div>
      </div>
    </header>
  );
}

function SideNav({ activePage, onChange }: { activePage: ActivePage; onChange: (page: ActivePage) => void }) {
  const navItems: Array<{ label: string; page: ActivePage; icon: ReactNode }> = [
    { label: "运单智能导入", page: "import", icon: <Upload className="h-5 w-5" /> },
    { label: "异步任务进度", page: "tasks", icon: <Activity className="h-5 w-5" /> },
    { label: "导入监控", page: "monitor", icon: <BarChart3 className="h-5 w-5" /> },
    { label: "链路检索", page: "trace", icon: <Route className="h-5 w-5" /> },
    { label: "导入运单查询", page: "query", icon: <Search className="h-5 w-5" /> },
  ];

  return (
    <aside className="relative hidden w-60 shrink-0 bg-[var(--sidebar)] text-slate-200 md:block">
      <div className="flex h-12 items-center border-b border-white/10 px-4 text-sm font-semibold text-white">
        运单导入
      </div>

      <nav className="space-y-1 px-2 py-3">
        {navItems.map((item) => (
          <button
            type="button"
            key={item.label}
            onClick={() => onChange(item.page)}
            className={`flex h-12 w-full items-center gap-3 rounded-sm px-3 text-left text-[15px] font-semibold ${
              activePage === item.page ? "bg-[var(--sidebar-active)] text-white" : "text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="absolute bottom-4 left-3 hidden h-11 w-36 items-center justify-between rounded-md bg-white px-3 text-sm text-slate-700 md:flex">
        预发环境
        <span className="h-6 w-12 rounded-full bg-slate-200 p-1">
          <span className="block h-4 w-4 rounded-full bg-white shadow" />
        </span>
      </div>
    </aside>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">{children}</div>;
}

function StatCard({ icon, title, value }: { icon: ReactNode; title: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--line)] bg-slate-50/50 p-3">
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">
          {icon}
        </span>
        {title}
      </div>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-[var(--line)] bg-slate-50/50 px-3 py-2">
      <span className="text-sm text-[var(--muted)]">{label}</span>
      <span className="truncate text-right text-sm font-medium">{value}</span>
    </div>
  );
}

function ProgressBar({ label, current, total }: { label: string; current: number; total: number }) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-[var(--muted)]">
        <span>{label || "等待任务"}</span>
        <span>
          {current}/{total || 0} · {percent}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="sticky top-0 z-10 border-b border-r border-[var(--line)] bg-[#f7f9fb] px-3 py-3 text-center text-sm font-semibold text-slate-900">{children}</th>;
}

function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`border-b border-r border-[var(--line)] px-3 py-2.5 align-middle ${className}`}>{children}</td>;
}

function InputField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-slate-700">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded border border-[var(--line-strong)] bg-white px-3 text-sm outline-none"
      />
    </label>
  );
}
