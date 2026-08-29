import { Notice } from "obsidian";
import { fetchCompletedTasksByRange } from "../completedTaskCache";
import DidaSyncPlugin from "../main";
import { formatTaskLine } from "../taskLineFormat";
import { applyTaskScheduleToPayload, mergeRemoteTaskSchedule } from "../taskScheduleSync";
import { DidaTask, PendingPlacementOperationPayload, PendingSyncOperation, PendingSyncOperationType, SyncFailureDetail, SyncResult, SyncRunState } from "../types";
import { ensureTaskCompletedTime, normalizeRemoteCompletedTime } from "../utils";
import { TASK_VIEW_TYPE, TaskView } from "../views/TaskView";

// Reverse completion verification constants
const REVERSE_COMPLETION_MISSING_THRESHOLD = 1;
const REVERSE_COMPLETION_MAX_VERIFY_PER_SYNC = 20;
const REVERSE_COMPLETION_FOLLOWUP_DELAY_MS = 2000;
const REVERSE_COMPLETION_MAX_FOLLOWUP_PASSES = 6;
const SYNC_RUN_TIMEOUT_MS = 90000;

export class SyncManager {
    plugin: DidaSyncPlugin;
    isSyncing: boolean = false;
    _reverseCompletionFollowUpInProgress: boolean = false;
    _reverseCompletionFollowUpTimer: number | null = null;
    _syncConsistencyFollowUpInProgress: boolean = false;
    _syncConsistencyFollowUpTimer: number | null = null;
    private _activeSyncPromise: Promise<SyncResult> | null = null;
    private _rerunRequested: boolean = false;
    private _disposed: boolean = false;
    private _syncState: SyncRunState = {
        phase: "idle",
        isRunning: false,
        queued: false,
        startedAt: null,
        finishedAt: null,
        message: "未同步"
    };

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
    }

    getSyncState(): SyncRunState {
        return { ...this._syncState };
    }

    private setSyncState(patch: Partial<SyncRunState>) {
        this._syncState = { ...this._syncState, ...patch };
        if (typeof this.plugin.refreshTaskView === "function") this.plugin.refreshTaskView();
    }

    private emptySyncResult(outcome: SyncResult["outcome"] = "success"): SyncResult {
        return { outcome, uploaded: 0, downloaded: 0, failedScopes: [], failedOperations: [], cleanupPerformed: false };
    }

    private mergeSyncResults(current: SyncResult, next: SyncResult): SyncResult {
        const failedScopes = [...current.failedScopes, ...next.failedScopes];
        const failedOperations = [...current.failedOperations, ...next.failedOperations];
        const failedDetails = [...(current.failedDetails || []), ...(next.failedDetails || [])];
        const outcome = current.outcome === "failed" || next.outcome === "failed"
            ? "failed"
            : current.outcome === "partial" || next.outcome === "partial" || failedScopes.length > 0 || failedOperations.length > 0
                ? "partial"
                : next.outcome === "skipped" && current.outcome === "skipped"
                    ? "skipped"
                    : "success";
        return {
            outcome,
            uploaded: current.uploaded + next.uploaded,
            downloaded: current.downloaded + next.downloaded,
            failedScopes,
            failedOperations,
            failedDetails,
            cleanupPerformed: current.cleanupPerformed || next.cleanupPerformed
        };
    }

    private async withRunTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                work,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`同步运行超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    getPendingOperations(): PendingSyncOperation[] {
        if (!Array.isArray(this.plugin.settings.pendingSyncOperations)) {
            this.plugin.settings.pendingSyncOperations = [];
        }
        return this.plugin.settings.pendingSyncOperations;
    }

    hasPendingOperation(task: DidaTask): boolean {
        return this.getPendingOperations().some(operation =>
            operation.localTaskId === task.id || (!!task.didaId && operation.didaId === task.didaId)
        );
    }

    private getPendingOperation(task: DidaTask): PendingSyncOperation | undefined {
        return this.getPendingOperations().find(operation =>
            operation.localTaskId === task.id || (!!task.didaId && operation.didaId === task.didaId)
        );
    }

    private shouldPreferPendingLocalChange(operation: PendingSyncOperation, remote: any): boolean {
        const remoteModified = remote?.modifiedTime || remote?.updatedTime || remote?.updateTime;
        if (!remoteModified) return true;
        const remoteTime = Date.parse(remoteModified);
        const localTime = Date.parse(operation.modifiedAt || operation.createdAt);
        if (!Number.isFinite(remoteTime) || !Number.isFinite(localTime)) return true;
        return localTime >= remoteTime;
    }

    hasPendingDelete(didaId: string): boolean {
        return this.getPendingOperations().some(operation => operation.didaId === didaId && operation.type === "delete");
    }

    private isInboxProjectId(projectId: string | null | undefined): boolean {
        if (!projectId) return true;
        return projectId === "inbox" || projectId.startsWith("inbox");
    }

    private getUserTimeZone(): string {
        if (typeof this.plugin.getUserTimeZone === "function") return this.plugin.getUserTimeZone();
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        } catch (_error) {
            return "UTC";
        }
    }

    private cacheRemoteInboxProjectId(projectId: string | null | undefined): boolean {
        if (!projectId || projectId === "inbox" || !projectId.startsWith("inbox")) return false;
        if (this.plugin.settings.remoteInboxProjectId === projectId) return false;
        this.plugin.settings.remoteInboxProjectId = projectId;
        return true;
    }

    private normalizeRemoteProjectId(projectId: string | null | undefined): string {
        if (this.isInboxProjectId(projectId)) {
            this.cacheRemoteInboxProjectId(projectId || null);
            return "inbox";
        }
        return projectId as string;
    }

    private clearPendingOperationsForNoteItems() {
        if (!Array.isArray(this.plugin.settings.pendingSyncOperations)) return 0;
        const before = this.plugin.settings.pendingSyncOperations.length;
        this.plugin.settings.pendingSyncOperations = this.plugin.settings.pendingSyncOperations.filter((operation: any) => {
            if (!operation) return false;
            const task = (this.plugin.settings.tasks || []).find((item: any) =>
                item.id === operation.localTaskId || (!!operation.didaId && item.didaId === operation.didaId)
            );
            return !(task && this.plugin.isNoteSyncTaskLike && this.plugin.isNoteSyncTaskLike(task));
        });
        return before - this.plugin.settings.pendingSyncOperations.length;
    }

    private async ensureRemoteInboxProjectId(): Promise<string> {
        const cached = this.plugin.settings.remoteInboxProjectId;
        if (cached && cached !== "inbox" && cached.startsWith("inbox")) return cached;

        const candidates = [
            ...(this.plugin.settings.projects || []),
            ...(this.plugin.settings.projectCatalog || []),
            ...(this.plugin.settings.tasks || [])
        ];
        for (const item of candidates) {
            const id = typeof item?.projectId === "string" ? item.projectId : item?.id;
            const name = typeof item?.projectName === "string" ? item.projectName : item?.name;
            if (id && id !== "inbox" && id.startsWith("inbox") && (!name || name === "收集箱" || String(name).toLowerCase() === "inbox")) {
                this.plugin.settings.remoteInboxProjectId = id;
                await this.plugin.saveSettings();
                return id;
            }
        }

        const title = `DidaSync inbox probe ${Date.now()}`;
        const res = await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl("/task"), {
            method: "POST",
            body: JSON.stringify({ title, content: "", desc: "" })
        } as any);
        if (!res.ok) throw new Error("无法创建临时任务以识别远端收集箱 ID: " + res.status);
        const data = await this.readResponseJson<any>(res, {});
        const inboxId = typeof data.projectId === "string" ? data.projectId : "";
        if (!inboxId || inboxId === "inbox" || !inboxId.startsWith("inbox")) {
            throw new Error("无法从临时任务识别远端收集箱 ID");
        }
        this.plugin.settings.remoteInboxProjectId = inboxId;
        await this.plugin.saveSettings();

        if (data.id) {
            try {
                await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl(`/project/${inboxId}/task/${data.id}`), {
                    method: "DELETE"
                } as any);
            } catch (_error) { }
        }
        return inboxId;
    }

    private async resolveRemoteProjectId(projectId: string | null | undefined): Promise<string> {
        if (projectId === "local") throw new Error("本地项目不能同步到滴答清单远端");
        if (this.isInboxProjectId(projectId)) return this.ensureRemoteInboxProjectId();
        return projectId as string;
    }

    private getTaskIdentityKeys(task: DidaTask | null | undefined): string[] {
        if (!task) return [];
        return [task.id, task.didaId].filter((key): key is string => !!key);
    }

    private findTaskByAnyId(id: string | null | undefined): DidaTask | undefined {
        if (!id) return undefined;
        return (this.plugin.settings.tasks || []).find((task) => task.id === id || task.didaId === id);
    }

    private getTaskUploadDepth(task: DidaTask, seen: Set<string> = new Set()): number {
        const key = task.id || task.didaId;
        if (key) {
            if (seen.has(key)) return 0;
            seen.add(key);
        }
        const parent = this.findTaskByAnyId(task.parentId);
        if (!parent) return 0;
        return 1 + this.getTaskUploadDepth(parent, seen);
    }

    private sortTasksForUpload(tasks: DidaTask[]): DidaTask[] {
        return tasks
            .map((task, index) => ({ task, index, depth: this.getTaskUploadDepth(task) }))
            .sort((a, b) => a.depth - b.depth || a.index - b.index)
            .map((item) => item.task);
    }

    private sortPendingOperationsForFlush(operations: PendingSyncOperation[]): PendingSyncOperation[] {
        return operations
            .map((operation, index) => {
                const task = this.plugin.settings.tasks.find(item =>
                    item.id === operation.localTaskId || (!!operation.didaId && item.didaId === operation.didaId)
                );
                const depth = task && (operation.type === "upsert" || operation.type === "complete" || operation.type === "placement")
                    ? this.getTaskUploadDepth(task)
                    : 0;
                return { operation, index, depth };
            })
            .sort((a, b) => a.depth - b.depth || a.index - b.index)
            .map((item) => item.operation);
    }

    private normalizeChildrenParentId(parent: DidaTask) {
        if (!parent.id || !parent.didaId) return;
        for (const child of this.plugin.settings.tasks || []) {
            if (child.parentId === parent.id) child.parentId = parent.didaId;
        }
    }

    private assertNoParentCycle(task: DidaTask) {
        const seen = new Set<string>();
        let current: DidaTask | undefined = task;
        while (current) {
            const keys = this.getTaskIdentityKeys(current);
            if (keys.some(key => seen.has(key))) throw new Error("检测到循环父任务关系");
            for (const key of keys) seen.add(key);
            current = this.findTaskByAnyId(current.parentId);
        }
    }

    private async resolveRemoteParentId(task: DidaTask, seen: Set<string> = new Set()): Promise<string | null | undefined> {
        this.assertNoParentCycle(task);
        if (task.parentId === undefined) return undefined;
        if (task.parentId === null || task.parentId === "") return null;

        const parent = this.findTaskByAnyId(task.parentId);
        if (!parent) return task.parentId;

        const taskKeys = new Set(this.getTaskIdentityKeys(task));
        if (this.getTaskIdentityKeys(parent).some(key => taskKeys.has(key))) {
            throw new Error("不能将任务设为自己的父任务");
        }

        const parentKey = parent.id || parent.didaId;
        if (parentKey) {
            if (seen.has(parentKey)) throw new Error("检测到循环父任务关系");
            seen.add(parentKey);
        }

        if (!parent.didaId) {
            await this.createTaskInDidaList(parent, false);
        }
        if (!parent.didaId) throw new Error("父任务未同步，无法同步子任务");

        if (task.parentId !== parent.didaId) {
            task.parentId = parent.didaId;
            this.normalizeChildrenParentId(parent);
            await this.plugin.saveSettings();
        }
        return parent.didaId;
    }

    private encodeParentIdForTaskUpdate(parentId: string | null): string {
        return parentId === null ? "" : parentId;
    }

    async queueOperation(task: DidaTask, type: PendingSyncOperationType, payload?: PendingSyncOperation["payload"]) {
        const operations = this.getPendingOperations();
        if (this.plugin.isNoteSyncTaskLike && this.plugin.isNoteSyncTaskLike(task)) {
            const remaining = operations.filter(operation =>
                operation.localTaskId !== task.id && (!task.didaId || operation.didaId !== task.didaId)
            );
            if (remaining.length !== operations.length) {
                this.plugin.settings.pendingSyncOperations = remaining;
                await this.plugin.saveSettings();
            }
            return;
        }
        const existing = operations.find(operation => operation.localTaskId === task.id);
        const next: PendingSyncOperation = {
            localTaskId: task.id,
            didaId: task.didaId,
            projectId: task.projectId || "inbox",
            type,
            payload: type === "delete" ? undefined : (payload || { ...task }),
            createdAt: existing?.createdAt || new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            attempts: existing?.attempts || 0
        };
        this.plugin.settings.pendingSyncOperations = operations.filter(operation => operation.localTaskId !== task.id);
        this.plugin.settings.pendingSyncOperations.push(next);
        await this.plugin.saveSettings();
    }

    async clearOperation(task: DidaTask) {
        const current = this.getPendingOperations();
        const remaining = current.filter(operation =>
            operation.localTaskId !== task.id && (!task.didaId || operation.didaId !== task.didaId)
        );
        if (remaining.length === current.length) return;
        this.plugin.settings.pendingSyncOperations = remaining;
        if (!remaining.some((operation) => operation.localTaskId === task.id && operation.type === "placement")) {
            task.syncPlacementPending = false;
            task.syncPlacementError = undefined;
        }
        await this.plugin.saveSettings();
    }

    async markOperationFailed(task: DidaTask, error: any) {
        const operation = this.getPendingOperations().find(item => item.localTaskId === task.id);
        if (operation) {
            operation.attempts += 1;
            operation.lastError = error?.message || String(error);
            await this.plugin.saveSettings();
        }
    }

    async flushPendingOperations(): Promise<{ uploaded: number; failed: string[]; failures: SyncFailureDetail[] }> {
        let uploaded = 0;
        const failed: string[] = [];
        const failures: SyncFailureDetail[] = [];
        for (const operation of this.sortPendingOperationsForFlush([...this.getPendingOperations()])) {
            if (!this.getPendingOperations().some(item => item === operation)) continue;
            const task = this.plugin.settings.tasks.find(item =>
                item.id === operation.localTaskId || (!!operation.didaId && item.didaId === operation.didaId)
            );
            try {
                if (task && this.plugin.isNoteSyncTaskLike && this.plugin.isNoteSyncTaskLike(task)) {
                    this.plugin.settings.pendingSyncOperations = this.getPendingOperations().filter(item => item !== operation);
                    await this.plugin.saveSettings();
                    continue;
                }
                if (operation.type === "delete") {
                    if (operation.didaId) {
                        await this.deleteTaskInDidaList(operation.didaId, operation.projectId || "inbox", false);
                    } else {
                        this.plugin.settings.pendingSyncOperations = this.getPendingOperations().filter(item => item !== operation);
                        await this.plugin.saveSettings();
                    }
                } else if (operation.type === "placement") {
                    if (task) await this.flushPlacementOperation(task, operation);
                    else {
                        this.plugin.settings.pendingSyncOperations = this.getPendingOperations().filter(item => item !== operation);
                        await this.plugin.saveSettings();
                    }
                } else if (task) {
                    if (!task.didaId) await this.createTaskInDidaList(task, false);
                    else if (operation.type === "complete") await this.toggleTaskInDidaList(task, false);
                    else await this.updateTaskInDidaList(task, false);
                } else {
                    this.plugin.settings.pendingSyncOperations = this.getPendingOperations().filter(item => item !== operation);
                    await this.plugin.saveSettings();
                }
                uploaded++;
            } catch (error: any) {
                operation.attempts += 1;
                operation.lastError = error?.message || String(error);
                const reason = operation.lastError || "未知上传错误";
                failed.push(reason);
                failures.push({
                    localTaskId: operation.localTaskId,
                    didaId: operation.didaId || task?.didaId,
                    title: task?.title || (typeof operation.payload === "object" && operation.payload && "title" in operation.payload
                        ? String((operation.payload as any).title || "")
                        : ""),
                    projectName: task?.projectName,
                    operation: operation.type || "upsert",
                    reason,
                    attempts: operation.attempts
                });
                await this.plugin.saveSettings();
            }
        }
        return { uploaded, failed, failures };
    }

    private getPlacementPayload(operation: PendingSyncOperation): PendingPlacementOperationPayload {
        const payload = operation.payload;
        if (!payload || typeof payload !== "object" || !("fromProjectId" in payload) || !("toProjectId" in payload)) {
            throw new Error("位置同步数据缺失");
        }
        return payload as PendingPlacementOperationPayload;
    }

    private async removeOperation(operation: PendingSyncOperation) {
        this.plugin.settings.pendingSyncOperations = this.getPendingOperations().filter((item) => item !== operation);
        await this.plugin.saveSettings();
    }

    private async updatePlacementState(task: DidaTask, pending: boolean, error?: string) {
        task.syncPlacementPending = pending;
        task.syncPlacementError = error;
        await this.plugin.saveSettings();
        this.plugin.refreshTaskView();
    }

    private restorePlacementLocally(task: DidaTask, payload: PendingPlacementOperationPayload) {
        const fromProjectId = payload.fromProjectId || "inbox";
        const display = typeof this.plugin.getProjectDisplayInfo === "function"
            ? this.plugin.getProjectDisplayInfo(fromProjectId, payload.fromProjectName)
            : { id: fromProjectId, name: payload.fromProjectName || fromProjectId };
        task.projectId = display.id;
        task.projectName = display.name;
        task.projectColor = display.color;
        task.projectClosed = display.closed;
        task.projectViewMode = display.viewMode;
        task.projectKind = display.kind;
        task.projectPermission = display.permission;
        task.parentId = payload.fromParentId ?? null;
        task.updatedAt = new Date().toISOString();
    }

    private async rollbackPlacementMove(task: DidaTask, payload: PendingPlacementOperationPayload): Promise<boolean> {
        if (!task.didaId || payload.fromProjectId === payload.toProjectId) return true;
        try {
            const remoteFromProjectId = await this.resolveRemoteProjectId(payload.toProjectId);
            const remoteToProjectId = await this.resolveRemoteProjectId(payload.fromProjectId);
            await this.plugin.apiClient.moveTask(remoteFromProjectId, remoteToProjectId, task.didaId);
            return true;
        } catch (_error) {
            return false;
        }
    }

    private async flushPlacementOperation(task: DidaTask, operation: PendingSyncOperation) {
        if (!task.didaId) {
            await this.updatePlacementState(task, true);
            await this.createTaskInDidaList(task, false, false);
            if (!task.didaId) throw new Error("任务创建后未返回远端 ID");
        }

        const payload = this.getPlacementPayload(operation);
        const fromProjectId = payload.fromProjectId || "inbox";
        const toProjectId = payload.toProjectId || task.projectId || "inbox";
        const fromParentId = payload.fromParentId ?? null;
        const toParentId = await this.resolvePlacementRemoteParentId(task, payload);
        const movedAcrossProjects = fromProjectId !== toProjectId;
        const changedParent = fromParentId !== toParentId;
        let moved = false;

        await this.updatePlacementState(task, true);

        try {
            if (movedAcrossProjects) {
                const remoteFromProjectId = await this.resolveRemoteProjectId(fromProjectId);
                const remoteToProjectId = await this.resolveRemoteProjectId(toProjectId);
                await this.plugin.apiClient.moveTask(remoteFromProjectId, remoteToProjectId, task.didaId);
                moved = true;
            }
            if (changedParent) {
                task.parentId = toParentId;
                await this.updateTaskInDidaList(task, false, false);
            }
            await this.removeOperation(operation);
            await this.updatePlacementState(task, false);
        } catch (error: any) {
            const message = error?.message || String(error);
            if (!moved) {
                task.syncPlacementPending = true;
                task.syncPlacementError = message;
                await this.plugin.saveSettings();
                this.plugin.refreshTaskView();
                throw error;
            }

            const rolledBack = await this.rollbackPlacementMove(task, payload);
            if (rolledBack) {
                this.restorePlacementLocally(task, payload);
                await this.removeOperation(operation);
                await this.updatePlacementState(task, false, message);
                throw error;
            }

            payload.fromProjectId = toProjectId;
            payload.fromProjectName = payload.toProjectName;
            payload.fromParentId = null;
            operation.payload = payload;
            task.syncPlacementPending = true;
            task.syncPlacementError = message;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
            throw error;
        }
    }

    private async resolvePlacementRemoteParentId(task: DidaTask, payload: PendingPlacementOperationPayload): Promise<string | null> {
        if (payload.toParentId === null || payload.toParentId === undefined || payload.toParentId === "") {
            task.parentId = null;
            return null;
        }
        const parent = this.findTaskByAnyId(payload.parentTaskId)
            || this.findTaskByAnyId(payload.parentDidaId)
            || this.findTaskByAnyId(payload.toParentId);
        if (!parent) {
            task.parentId = payload.toParentId;
            return payload.toParentId;
        }
        if (!parent.didaId) await this.createTaskInDidaList(parent, false);
        if (!parent.didaId) throw new Error("父任务未同步，无法同步位置");
        task.parentId = parent.didaId;
        payload.toParentId = parent.didaId;
        payload.parentTaskId = parent.id;
        payload.parentDidaId = parent.didaId;
        return parent.didaId;
    }

    async syncToDidaList(): Promise<SyncResult> {
        const result: SyncResult = { outcome: "success", uploaded: 0, downloaded: 0, failedScopes: [], failedOperations: [], cleanupPerformed: false };
        if (this.plugin.settings.accessToken) {
            try {
                this.plugin.updateStatusBar("同步中...");
                for (const task of this.sortTasksForUpload(this.plugin.settings.tasks || [])) {
                    if (this.plugin.isTaskListItem && !this.plugin.isTaskListItem(task)) continue;
                    if (!task.didaId && !this.hasPendingOperation(task)) await this.queueOperation(task, "upsert");
                }
                const flushed = await this.flushPendingOperations();
                result.uploaded = flushed.uploaded;
                result.failedOperations = flushed.failed;
                result.failedDetails = flushed.failures;
                result.outcome = flushed.failed.length > 0 ? (flushed.uploaded > 0 ? "partial" : "failed") : "success";
                this.plugin.updateStatusBar(result.outcome === "success" ? "已连接" : result.outcome === "partial" ? "部分同步失败" : "同步失败");
            } catch (e) {
                result.outcome = "failed";
                result.failedOperations.push(e instanceof Error ? e.message : String(e));
                this.plugin.updateStatusBar("同步失败");
            }
        } else {
            new Notice("请先进行OAuth认证");
            result.outcome = "failed";
            result.failedOperations.push("未认证");
        }
        return result;
    }

    async syncNewTasksToDidaList(): Promise<SyncResult> {
        const result: SyncResult = { outcome: "success", uploaded: 0, downloaded: 0, failedScopes: [], failedOperations: [], cleanupPerformed: false };
        for (const task of this.sortTasksForUpload(this.plugin.settings.tasks || [])) {
            if (this.plugin.isTaskListItem && !this.plugin.isTaskListItem(task)) continue;
            if (!task.didaId && !this.hasPendingOperation(task)) await this.queueOperation(task, "upsert");
        }
        const flushed = await this.flushPendingOperations();
        result.uploaded = flushed.uploaded;
        result.failedOperations = flushed.failed;
        result.failedDetails = flushed.failures;
        if (flushed.failed.length > 0) result.outcome = flushed.uploaded > 0 ? "partial" : "failed";
        return result;
    }

    async runBidirectionalSync(): Promise<SyncResult> {
        const skipped = this.emptySyncResult("skipped");
        if (!this.plugin.settings.accessToken || this.plugin.isReverseUpdating || this._disposed) return skipped;
        if (this._activeSyncPromise) {
            this._rerunRequested = true;
            this.setSyncState({ phase: "queued", queued: true, message: "当前同步结束后再次同步" });
            this.plugin.updateStatusBar("已排队再次同步");
            return this._activeSyncPromise;
        }

        this.isSyncing = true;
        this.setSyncState({
            phase: "uploading",
            isRunning: true,
            queued: false,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            message: "正在上传本地修改"
        });

        const runPromise = this.runSyncLoop().finally(() => {
            this.isSyncing = false;
            this._activeSyncPromise = null;
            this.setSyncState({
                isRunning: false,
                queued: false,
                finishedAt: new Date().toISOString()
            });
        });
        this._activeSyncPromise = runPromise;
        return runPromise;
    }

    private async runSyncLoop(): Promise<SyncResult> {
        let aggregate = this.emptySyncResult("skipped");
        do {
            this._rerunRequested = false;
            let result: SyncResult;
            try {
                result = await this.withRunTimeout(this.runSingleBidirectionalSync(), SYNC_RUN_TIMEOUT_MS);
            } catch (error: any) {
                const message = error?.message || String(error);
                result = { ...this.emptySyncResult("failed"), failedOperations: [message] };
                this.plugin.updateStatusBar("同步超时");
            }
            aggregate = aggregate.outcome === "skipped" ? result : this.mergeSyncResults(aggregate, result);
        } while (this._rerunRequested && !this._disposed);
        return aggregate;
    }

    private async runSingleBidirectionalSync(): Promise<SyncResult> {
        const failed = this.emptySyncResult("failed");
        this.setSyncState({ phase: "uploading", queued: false, message: "正在上传本地修改" });
        this.plugin.updateStatusBar("上传本地修改...");
        try {
            const upload = await this.syncNewTasksToDidaList();
            this.setSyncState({ phase: "downloading", message: "正在拉取远端任务" });
            this.plugin.updateStatusBar("拉取远端任务...");
            const download = await this.syncFromDidaList(true);
            const failedOperations = [...upload.failedOperations, ...download.failedOperations];
            const failedDetails = [...(upload.failedDetails || []), ...(download.failedDetails || [])];
            const failedScopes = [...download.failedScopes];
            const outcome = download.outcome === "failed"
                ? "failed"
                : failedOperations.length > 0 || download.outcome === "partial"
                    ? "partial"
                    : "success";
            const result: SyncResult = {
                outcome,
                uploaded: upload.uploaded,
                downloaded: download.downloaded,
                failedScopes,
                failedOperations,
                failedDetails,
                cleanupPerformed: download.cleanupPerformed
            };
            this.setSyncState({
                phase: outcome === "failed" ? "failed" : "completed",
                message: outcome === "success" ? "同步完成" : outcome === "partial" ? "部分同步失败" : "同步失败"
            });
            this.plugin.updateStatusBar(outcome === "success" ? "已连接" : outcome === "partial" ? "部分同步失败" : "同步失败");
            return result;
        } catch (error: any) {
            const message = error?.message || String(error);
            this.setSyncState({ phase: "failed", message });
            this.plugin.updateStatusBar("同步失败");
            return { ...failed, failedOperations: [message] };
        }
    }

    async syncFromDidaList(lockHeld: boolean = false): Promise<SyncResult> {
        const result: SyncResult = { outcome: "success", uploaded: 0, downloaded: 0, failedScopes: [], failedOperations: [], cleanupPerformed: false };
        if (!this.plugin.settings.accessToken) {
            new Notice("请先进行OAuth认证");
            return { ...result, outcome: "failed", failedScopes: ["authentication"] };
        }
        if (this.plugin.isReverseUpdating || (!lockHeld && this.isSyncing)) return { ...result, outcome: "skipped" };
        if (!lockHeld) this.isSyncing = true;
        try {
            this.plugin.updateStatusBar("同步中...");
            const tasks: any[] = [];
            let projectListSucceeded = false;
            let inboxSucceeded = false;
            const successfulProjects = new Set<string>();
            const expectedProjects = new Set<string>();
            let updatedCount = 0;
            const projectMap = new Map<string, any>();
            try {
                const res = await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl("/project"));
                if (res.ok) {
                    const list = await res.json();
                    if (Array.isArray(list)) {
                        projectListSucceeded = true;
                        const previousRemoteInboxProjectId = this.plugin.settings.remoteInboxProjectId || "";
                        list.forEach(p => {
                            const localProjectId = this.normalizeRemoteProjectId(p.id);
                            if (!this.plugin.isNoteProjectLike(p)) expectedProjects.add(localProjectId);
                            projectMap.set(localProjectId, {
                                id: localProjectId,
                                name: p.name,
                                color: p.color,
                                closed: p.closed,
                                groupId: p.groupId,
                                viewMode: p.viewMode,
                                permission: p.permission,
                                kind: p.kind
                            });
                        });
                        if ((this.plugin.settings.remoteInboxProjectId || "") !== previousRemoteInboxProjectId) await this.plugin.saveSettings();
                        if (!projectMap.has("inbox")) {
                            projectMap.set("inbox", {
                                id: "inbox",
                                name: "收集箱",
                                color: "#F18181",
                                closed: false,
                                groupId: null,
                                viewMode: "list",
                                permission: "write",
                                kind: "TASK"
                            });
                        }
                        if (this.plugin.mergeRemoteProjectsIntoCatalog(projectMap)) {
                            await this.plugin.saveSettings();
                        }
                        for (const project of list) {
                            let projectFetched = false;
                            let projectError = "未能获取任务数据";
                            for (const url of [
                                this.plugin.apiClient.buildApiUrl(`/project/${project.id}/task`),
                                this.plugin.apiClient.buildApiUrl(`/project/${project.id}/data`),
                                this.plugin.apiClient.buildApiUrl(`/task?projectId=${project.id}`)
                            ]) {
                                try {
                                    const res = await this.plugin.apiClient.makeAuthenticatedRequest(url);
                                    if (res.ok) {
                                        const data = await res.json();
                                        let items: any[] = [];
                                        let validPayload = false;
                                        if (Array.isArray(data)) {
                                            items = data;
                                            validPayload = true;
                                        } else if (data && data.tasks && Array.isArray(data.tasks)) {
                                            items = data.tasks;
                                            validPayload = true;
                                        } else if (data && data.data && Array.isArray(data.data)) {
                                            items = data.data;
                                            validPayload = true;
                                        }
                                        if (validPayload) {
                                            projectFetched = true;
                                            const localProjectId = this.normalizeRemoteProjectId(project.id);
                                            if (!this.plugin.isNoteProjectLike(project)) successfulProjects.add(localProjectId);
                                            items.forEach(t => {
                                                const proj = projectMap.get(localProjectId);
                                                t.projectId = localProjectId;
                                                t.projectName = localProjectId === "inbox" ? "收集箱" : project.name;
                                                t.projectColor = proj?.color;
                                                t.projectClosed = proj?.closed;
                                                t.projectViewMode = proj?.viewMode;
                                                t.projectKind = proj?.kind;
                                                t.projectPermission = proj?.permission;
                                            });
                                            tasks.push(...items);
                                            break;
                                        }
                                        projectError = `响应格式无效（HTTP ${res.status}）`;
                                    } else {
                                        projectError = `HTTP ${res.status}`;
                                    }
                                } catch (e: any) {
                                    projectError = e?.message || String(e);
                                }
                            }
                            if (!projectFetched) result.failedScopes.push(`project:${project.id}：${projectError}`);
                        }
                    }
                }
            } catch (e) { }
            if (!projectListSucceeded) result.failedScopes.push("projects");

            try {
                const remoteInboxProjectId = await this.ensureRemoteInboxProjectId().catch(() => "inbox");
                let inboxError = "未能获取收集箱任务";
                for (const url of [
                    this.plugin.apiClient.buildApiUrl(`/project/${remoteInboxProjectId}/task`),
                    this.plugin.apiClient.buildApiUrl(`/project/${remoteInboxProjectId}/data`),
                    this.plugin.apiClient.buildApiUrl(`/task?projectId=${remoteInboxProjectId}`),
                    this.plugin.apiClient.buildApiUrl("/task")
                ]) {
                    try {
                        const res = await this.plugin.apiClient.makeAuthenticatedRequest(url);
                        if (res.ok) {
                            const data = await res.json();
                            let items: any[] = [];
                            let validPayload = false;
                            if (Array.isArray(data)) {
                                items = url.endsWith("/open/v1/task") ? data.filter(t => this.isInboxProjectId(t.projectId)) : data;
                                validPayload = true;
                            } else if (data && data.tasks && Array.isArray(data.tasks)) {
                                items = data.tasks;
                                validPayload = true;
                            } else if (data && data.data && Array.isArray(data.data)) {
                                items = data.data;
                                validPayload = true;
                            }
                            if (validPayload) {
                                inboxSucceeded = true;
                                const proj = projectMap.get("inbox");
                                items.forEach(t => {
                                    t.projectId = this.normalizeRemoteProjectId(t.projectId);
                                    t.projectName = "收集箱";
                                    t.projectColor = proj?.color;
                                    t.projectClosed = proj?.closed;
                                    t.projectViewMode = proj?.viewMode;
                                    t.projectKind = proj?.kind;
                                    t.projectPermission = proj?.permission;
                                });
                                const ids = new Set(tasks.map(t => t.id));
                                const extra = items.filter(t => !ids.has(t.id));
                                tasks.push(...extra);
                                break;
                            }
                            inboxError = `响应格式无效（HTTP ${res.status}）`;
                        } else {
                            inboxError = `HTTP ${res.status}`;
                        }
                    } catch (e: any) {
                        inboxError = e?.message || String(e);
                    }
                }
                if (!inboxSucceeded) result.failedScopes.push(`inbox：${inboxError}`);
            } catch (e) { }

            const hasAnySuccessfulScope = inboxSucceeded || successfulProjects.size > 0;
            if (!hasAnySuccessfulScope) {
                throw new Error("未能从滴答清单拉取任务");
            }

            if (tasks.length > 0) {
                for (const remote of tasks) {
                    const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === remote.id);
                    if (idx === -1) {
                        if (this.hasPendingDelete(remote.id)) continue;
                        const proj = projectMap.get(remote.projectId) || { id: remote.projectId, name: remote.projectName || "未知项目" };
                        const localCopyIndex = this.findLocalRepeatTaskCopyIndex(remote);
                        if (localCopyIndex === -1) {
                            await this.createTaskFromDida(remote, proj);
                        } else {
                            await this.mergeRemoteRepeatTaskIntoLocalCopy(localCopyIndex, remote, proj);
                        }
                        updatedCount++;
                    } else {
                        const local = this.plugin.settings.tasks[idx];
                        const remoteKind = typeof remote.kind === "string" ? remote.kind.trim().toUpperCase() : "";
                        const pendingOperation = this.getPendingOperation(local);
                        if (pendingOperation && remoteKind !== "NOTE") {
                            if (this.shouldPreferPendingLocalChange(pendingOperation, remote)) continue;
                            await this.removeOperation(pendingOperation);
                        }
                        let changed = false;
                        if (remote.title && remote.title !== local.title) {
                            const oldTitle = local.title;
                            local.title = remote.title;
                            changed = true;
                            if (local.didaId) {
                                setTimeout(() => {
                                    this.plugin.isReverseUpdating = true;
                                    this.plugin.app.workspace.getLeavesOfType(TASK_VIEW_TYPE).forEach(leaf => {
                                        if (leaf.view instanceof TaskView && (leaf.view as any).updateNativeTaskTitle) {
                                            (leaf.view as any).updateNativeTaskTitle(local, oldTitle, remote.title);
                                        }
                                    });
                                    setTimeout(() => {
                                        this.plugin.isReverseUpdating = false;
                                    }, 1000);
                                }, 500);
                            }
                        }
                        if (remote.kind === "CHECKLIST") {
                            if (remote.desc !== undefined && remote.desc !== local.desc) {
                                local.desc = remote.desc || "";
                                changed = true;
                            }
                            if (remote.content !== local.content) {
                                local.content = remote.content || "";
                                changed = true;
                            }
                        } else {
                            if (remote.content !== undefined && remote.content !== local.content) {
                                local.content = remote.content || "";
                                changed = true;
                            }
                            if (remote.desc !== undefined && remote.desc !== local.desc) {
                                local.desc = remote.desc || "";
                                changed = true;
                            }
                        }
                        const mergedSchedule = mergeRemoteTaskSchedule(local, remote);
                        if (mergedSchedule.dueDate !== local.dueDate) {
                            const oldDue = local.dueDate;
                            local.dueDate = mergedSchedule.dueDate;
                            changed = true;
                            if (local.didaId) {
                                setTimeout(() => {
                                    this.plugin.app.workspace.getLeavesOfType(TASK_VIEW_TYPE).forEach(leaf => {
                                        if (leaf.view instanceof TaskView && (leaf.view as any).updateNativeTaskDueDate) {
                                            (leaf.view as any).updateNativeTaskDueDate(local, oldDue, mergedSchedule.dueDate);
                                        }
                                    });
                                }, 100);
                            }
                        }
                        if (mergedSchedule.startDate !== local.startDate) {
                            local.startDate = mergedSchedule.startDate;
                            changed = true;
                        }
                        if (remote.timeZone !== undefined && remote.timeZone !== local.timeZone) {
                            local.timeZone = remote.timeZone;
                            changed = true;
                        }
                        if (remote.etag !== undefined && remote.etag !== local.etag) {
                            local.etag = remote.etag;
                            changed = true;
                        }
                        if (remote.modifiedTime !== undefined && remote.modifiedTime !== local.modifiedTime) {
                            local.modifiedTime = remote.modifiedTime;
                            changed = true;
                        }
                        if (remote.isAllDay !== undefined && remote.isAllDay !== local.isAllDay) {
                            local.isAllDay = remote.isAllDay;
                            changed = true;
                        }
                        if (remote.kind !== undefined && remote.kind !== local.kind) {
                            local.kind = remote.kind;
                            changed = true;
                        }
                        if (remote.reminders !== undefined && JSON.stringify(remote.reminders) !== JSON.stringify(local.reminders)) {
                            local.reminders = remote.reminders;
                            changed = true;
                        }
                        if (remote.repeatFlag !== undefined && remote.repeatFlag !== local.repeatFlag) {
                            local.repeatFlag = remote.repeatFlag;
                            changed = true;
                        }
                        if (remote.priority !== undefined && remote.priority !== local.priority) {
                            local.priority = remote.priority;
                            changed = true;
                            if (local.didaId) {
                                setTimeout(() => {
                                    this.plugin.app.workspace.getLeavesOfType(TASK_VIEW_TYPE).forEach(leaf => {
                                        if (leaf.view instanceof TaskView && (leaf.view as any).updateNativeTaskDueDate) {
                                            (leaf.view as any).updateNativeTaskDueDate(local, local.dueDate, local.dueDate);
                                        }
                                    });
                                }, 100);
                            }
                        }
                        if (remote.status !== undefined && remote.status !== local.status) {
                            local.status = remote.status;
                            changed = true;
                        }
                        if (remote.status === 2) {
                            const completed = normalizeRemoteCompletedTime(remote.completedTime);
                            const previousCompletedTime = local.completedTime || null;
                            if (completed) local.completedTime = completed;
                            else ensureTaskCompletedTime(local);
                            if ((local.completedTime || null) !== previousCompletedTime) changed = true;
                        } else if (local.completedTime) {
                            local.completedTime = null;
                            changed = true;
                        }
                        if (remote.projectId !== undefined && remote.projectId !== local.projectId) {
                            local.projectId = remote.projectId;
                            changed = true;
                        }
                        if (remote.projectName !== undefined && remote.projectName !== local.projectName) {
                            local.projectName = remote.projectName;
                            changed = true;
                        }
                        if (remote.projectColor !== undefined && remote.projectColor !== local.projectColor) {
                            local.projectColor = remote.projectColor;
                            changed = true;
                        }
                        if (remote.projectClosed !== undefined && remote.projectClosed !== local.projectClosed) {
                            local.projectClosed = remote.projectClosed;
                            changed = true;
                        }
                        if (remote.projectViewMode !== undefined && remote.projectViewMode !== local.projectViewMode) {
                            local.projectViewMode = remote.projectViewMode;
                            changed = true;
                        }
                        if (remote.projectKind !== undefined && remote.projectKind !== local.projectKind) {
                            local.projectKind = remote.projectKind;
                            changed = true;
                        }
                        if (remote.projectPermission !== undefined && remote.projectPermission !== local.projectPermission) {
                            local.projectPermission = remote.projectPermission;
                            changed = true;
                        }
                        if (remote.items !== undefined && JSON.stringify(remote.items) !== JSON.stringify(local.items)) {
                            const mappedItems = remote.items.map((item: any) => {
                                const completedTime = normalizeRemoteCompletedTime(item.completedTime);
                                return completedTime ? { ...item, completedTime } : item;
                            });
                            local.items = mappedItems;
                            changed = true;
                        }
                        if (remote.parentId !== undefined && remote.parentId !== local.parentId) {
                            local.parentId = remote.parentId;
                            changed = true;
                        }
                        if (changed) {
                            local.updatedAt = new Date().toISOString();
                            if (remote.etag) local.etag = remote.etag;
                            await this.plugin.saveSettings();
                            updatedCount++;
                        }
                    }
                }
            }

            const clearedNotePendingCount = this.clearPendingOperationsForNoteItems();
            if (clearedNotePendingCount > 0) await this.plugin.saveSettings();

            const fullSnapshot = projectListSucceeded
                && inboxSucceeded
                && Array.from(expectedProjects).every(projectId => successfulProjects.has(projectId));
            if (lockHeld) this.setSyncState({ phase: "reconciling", message: "正在核对完成与删除状态" });
            if (fullSnapshot) this._refreshReverseCompletionSeenMeta(tasks);
            const deletedCount = 0;
            let extraCount = 0;
            let missingTaskVerificationSucceeded = fullSnapshot;
            if (fullSnapshot) {
                try {
                    extraCount = await this.markExtraTasksAsCompleted(tasks);
                } catch (_error) {
                    missingTaskVerificationSucceeded = false;
                    result.failedScopes.push("completed-tasks");
                }
            }
            const nativeCount = missingTaskVerificationSucceeded ? await this.markCompletedNativeTasksWithLinks(tasks) : 0;
            result.cleanupPerformed = missingTaskVerificationSucceeded;
            if (updatedCount > 0 || clearedNotePendingCount > 0 || deletedCount > 0 || extraCount > 0 || nativeCount > 0) {
                this.plugin.refreshTaskView();
            }
            result.downloaded += updatedCount;
            if (result.failedScopes.length > 0) {
                result.outcome = "partial";
                this.plugin.updateStatusBar("部分同步失败");
            } else {
                this.plugin.updateStatusBar("已连接");
            }
            if (fullSnapshot) this._scheduleSyncConsistencyFollowUp();
        } catch (e: any) {
            result.outcome = "failed";
            result.failedScopes.push(e?.message || String(e));
            this.plugin.updateStatusBar("同步失败");
        } finally {
            if (!lockHeld) this.isSyncing = false;
        }
        return result;
    }

    async syncDeletedTasks(tasks: any[]) {
        const remoteIds = new Set(tasks.map(t => t.id));
        const toDelete = this.plugin.settings.tasks.filter(t => t.didaId && !this.hasPendingOperation(t) && !this.plugin.isNoteSyncTaskLike(t)).filter(t => {
            if (remoteIds.has(t.didaId as string)) return false;
            if (t.status === 2) {
                if (t.items && Array.isArray(t.items) && t.items.length > 0) return false;
                if (this.plugin.settings.tasks.some(x => x.parentId === t.didaId)) return false;
                return false;
            }
            if (t.updatedAt) {
                const updated = new Date(t.updatedAt);
                if ((Date.now() - updated.getTime()) / 3600000 < 24) return false;
            }
            return true;
        });
        if (toDelete.length === 0) return 0;
        let count = 0;
        for (const task of toDelete) {
            try {
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                if (idx !== -1) {
                    this.plugin.settings.tasks.splice(idx, 1);
                    count++;
                }
            } catch (e) { }
        }
        if (count > 0) await this.plugin.saveSettings();
        return count;
    }

    async markExtraTasksAsCompleted(tasks: any[]) {
        const remoteIds = new Set(tasks.map(t => t.id));
        const extra = this.plugin.settings.tasks.filter(t => t.didaId && !this.hasPendingOperation(t) && !this.plugin.isNoteSyncTaskLike(t)).filter(t => !remoteIds.has(t.didaId as string) && t.status !== 2);
        if (extra.length === 0) return 0;
        const now = new Date();
        const candidateTimes = extra
            .map(task => {
                const meta = this._getReverseCompletionMeta(task.didaId as string);
                return meta.lastSeenAt || task.updatedAt || task.createdAt || null;
            })
            .map(value => value ? new Date(value).getTime() : NaN)
            .filter(value => Number.isFinite(value));
        const fallbackStart = now.getTime() - 90 * 24 * 60 * 60 * 1000;
        const earliestCandidateTime = candidateTimes.length > 0 ? Math.min(...candidateTimes) : fallbackStart;
        const startDate = new Date(Math.min(now.getTime(), earliestCandidateTime) - 24 * 60 * 60 * 1000);
        const completedResult = await fetchCompletedTasksByRange(
            { startDate, endDate: now },
            async query => {
                const completedTasks = await this.plugin.apiClient.getCompletedTasks(query);
                if (!Array.isArray(completedTasks)) throw new Error("已完成任务接口返回了无效数据");
                return completedTasks;
            }
        );
        if (completedResult.truncatedSegments.length > 0) {
            throw new Error("已完成任务记录不完整，跳过缺失任务清理");
        }
        const completedById = new Map<string, any>();
        for (const completedTask of completedResult.tasks) {
            const id = String(completedTask?.id || completedTask?.didaId || "").trim();
            if (id) completedById.set(id, completedTask);
        }
        let count = 0;
        const verifyBudget = { value: REVERSE_COMPLETION_MAX_VERIFY_PER_SYNC };
        const decisionCache = new Map<string, boolean>();
        for (const task of extra) {
            try {
                const completedTask = completedById.get(task.didaId as string);
                if (completedTask) {
                    task.remoteDeleted = false;
                    task.status = 2;
                    task.completedTime = normalizeRemoteCompletedTime(completedTask.completedTime);
                    ensureTaskCompletedTime(task);
                    task.updatedAt = now.toISOString();
                    count++;
                    continue;
                }
                if (!await this._decideReverseCompletion(task, { verifyBudget, decisionCache })) continue;
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                if (idx !== -1) {
                    const local = this.plugin.settings.tasks[idx];
                    if (!local.remoteDeleted) {
                        local.status = 2;
                        ensureTaskCompletedTime(local);
                    }
                    local.updatedAt = new Date().toISOString();
                    count++;
                }
            } catch (e) { }
        }
        await this.plugin.saveSettings();
        return count;
    }

    async markCompletedNativeTasksWithLinks(tasks: any[]) {
        if (!Array.isArray(tasks)) return 0;
        const remoteIds = new Set(tasks.map(t => t.id));
        const noteSyncDidaIds = new Set(
            this.plugin.settings.tasks
                .filter((task) => this.plugin.isNoteSyncTaskLike(task))
                .map((task) => task.didaId)
                .filter((id): id is string => typeof id === "string" && id.length > 0)
        );
        let count = 0;
        try {
            for (const file of this.plugin.app.vault.getMarkdownFiles()) {
                try {
                    const content = await this.plugin.app.vault.read(file);
                    const nativeTasks = this.plugin.nativeTaskSyncManager.detectNativeTasks(content, file.path).filter(t => {
                        if (!t.hasLink || !t.didaId || remoteIds.has(t.didaId) || noteSyncDidaIds.has(t.didaId)) return false;
                        const local = this.plugin.settings.tasks.find(task => task.didaId === t.didaId);
                        return local?.remoteDeleted === true || local?.status === 2;
                    });
                    if (nativeTasks.length > 0) {
                        const lines = content.split("\n");
                        let fileChanged = false;
                        for (const nativeTask of nativeTasks) {
                            const lineNumber = nativeTask.lineNumber;
                            if (lineNumber < lines.length) {
                                const line = lines[lineNumber];
                                const local = this.plugin.settings.tasks.find(task => task.didaId === nativeTask.didaId);
                                const replaced = local?.remoteDeleted
                                    ? formatTaskLine(line, { didaId: null, disconnected: true })
                                    : formatTaskLine(line, { checkbox: "x" });
                                if (replaced !== line) {
                                    lines[lineNumber] = replaced;
                                    count++;
                                    fileChanged = true;
                                }
                            }
                        }
                        if (fileChanged) {
                            const newContent = lines.join("\n");
                            await this.plugin.app.vault.modify(file, newContent);
                        }
                    }
                } catch (e) { }
            }
        } catch (e) { }
        const deletedIds = new Set(this.plugin.settings.tasks.filter(task => task.remoteDeleted && task.didaId).map(task => task.didaId as string));
        if (deletedIds.size > 0) {
            this.plugin.settings.tasks = this.plugin.settings.tasks.filter(task => !task.didaId || !deletedIds.has(task.didaId));
            for (const id of deletedIds) {
                delete this.plugin.settings.reverseCompletionMeta?.[id];
                delete this.plugin.settings.syncConsistencyMeta?.[id];
            }
            await this.plugin.saveSettings();
        }
        return count;
    }

    async deleteTaskInBackground(taskId: string, projectId: string) {
        try {
            await this.deleteTaskInDidaList(taskId, projectId);
            try {
                await this.syncFromDidaList();
            } catch (e) { }
        } catch (e) { }
    }

    async createTaskInDidaList(task: DidaTask, trackPending: boolean = true, clearOnSuccess: boolean = true) {
        if (trackPending) await this.queueOperation(task, "upsert");
        let content = task.content || "";
        let desc = task.desc || "";
        const wasCompleted = task.status === 2;
        const previousCompletedTime = task.completedTime || null;
        const remoteParentId = await this.resolveRemoteParentId(task);
        if (task.items && Array.isArray(task.items) && task.items.length > 0) {
            const merged = task.content || task.desc || "";
            content = merged;
            desc = merged;
        }
        const payload: any = {
            title: task.title,
            content,
            desc
        };
        if (task.projectId && !this.isInboxProjectId(task.projectId)) payload.projectId = await this.resolveRemoteProjectId(task.projectId);
        if (remoteParentId) payload.parentId = remoteParentId;
        if (task.items && Array.isArray(task.items)) payload.items = task.items;
        applyTaskScheduleToPayload(payload, task, this.getUserTimeZone());
        if (task.priority !== undefined) payload.priority = task.priority;
        if (typeof task.repeatFlag === "string") {
            const rf = task.repeatFlag.trim();
            payload.repeatFlag = rf === "" ? "" : rf;
        }
        try {
            const res = await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl("/task"), {
                method: "POST",
                body: JSON.stringify(payload)
            } as any);
            if (res.ok) {
                const data = await res.json();
                task.didaId = data.id;
                task.updatedAt = new Date().toISOString();
                task.etag = data.etag || null;
                task.status = data.status || 0;
                task.completedTime = normalizeRemoteCompletedTime(data.completedTime);
                if (wasCompleted && task.status !== 2) {
                    task.status = 2;
                    task.completedTime = previousCompletedTime || task.completedTime || null;
                    ensureTaskCompletedTime(task);
                    await this.completeTaskInDida(task);
                } else if (task.status === 2) {
                    ensureTaskCompletedTime(task);
                }
                const createdSchedule = mergeRemoteTaskSchedule(task, data);
                task.dueDate = createdSchedule.dueDate || null;
                task.startDate = createdSchedule.startDate || null;
                task.isAllDay = data.isAllDay || false;
                task.timeZone = data.timeZone || task.timeZone;
                task.modifiedTime = data.modifiedTime || task.modifiedTime;
                task.kind = data.kind || "TEXT";
                task.projectViewMode = data.projectViewMode || "list";
                task.projectKind = data.projectKind || "TASK";
                task.parentId = data.parentId || task.parentId || null;
                if (task.didaId) this.normalizeChildrenParentId(task);
                if (data.items && Array.isArray(data.items) && data.items.length > 0) task.items = data.items;
                task.reminders = data.reminders || [];
                task.repeatFlag = data.repeatFlag || null;
                task.priority = data.priority || 0;
                await this.plugin.saveSettings();
                if (clearOnSuccess) await this.clearOperation(task);
                return data;
            }
            const errorText = await res.text();
            throw new Error(`创建任务失败: ${res.status} - ${errorText}`);
        } catch (e) {
            if (trackPending) await this.markOperationFailed(task, e);
            throw e;
        }
    }

    async updateTaskInDidaList(task: DidaTask, trackPending: boolean = true, clearOnSuccess: boolean = true, includeParent: boolean = true) {
        if (task.didaId) {
            if (trackPending) await this.queueOperation(task, "upsert");
            let content = task.content || task.desc || "";
            const remoteParentId = await this.resolveRemoteParentId(task);
            const payload: any = {
                id: task.didaId,
                title: task.title,
                content,
                desc: content
            };
            if (task.status !== 2) payload.status = task.status;
            if (task.projectId && !this.isInboxProjectId(task.projectId)) payload.projectId = await this.resolveRemoteProjectId(task.projectId);
            applyTaskScheduleToPayload(payload, task, this.getUserTimeZone());
            if (task.priority !== undefined) payload.priority = task.priority;
            if (includeParent && remoteParentId !== undefined) payload.parentId = this.encodeParentIdForTaskUpdate(remoteParentId);
            if (task.items && Array.isArray(task.items)) payload.items = task.items;
            if (task.reminders && Array.isArray(task.reminders)) payload.reminders = task.reminders;
            if (typeof task.repeatFlag === "string") {
                const rf = task.repeatFlag.trim();
                payload.repeatFlag = rf === "" ? "" : rf;
            }
            if (task.status === 2) ensureTaskCompletedTime(task);
            try {
                const res = await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl("/task/" + task.didaId), {
                    method: "POST",
                    body: JSON.stringify(payload)
                } as any);
                if (!res.ok) {
                    await res.text();
                    throw new Error("更新任务失败: " + res.status);
                }
                const data = await this.readResponseJson(res, {});
                const updatedSchedule = mergeRemoteTaskSchedule(task, data);
                task.dueDate = updatedSchedule.dueDate;
                task.startDate = updatedSchedule.startDate;
                if (data.timeZone !== undefined) task.timeZone = data.timeZone;
                if (data.modifiedTime !== undefined) task.modifiedTime = data.modifiedTime;
                task.updatedAt = new Date().toISOString();
                if (data.etag !== undefined) task.etag = data.etag;
                if (data.priority !== undefined) task.priority = data.priority;
                if (task.status === 2) await this.completeTaskInDida(task);
                await this.plugin.saveSettings();
                if (clearOnSuccess) await this.clearOperation(task);
            } catch (e) {
                if (trackPending) await this.markOperationFailed(task, e);
                throw e;
            }
        }
    }

    private async completeTaskInDida(task: DidaTask) {
        if (!task.didaId) throw new Error("完成任务失败: 缺少远端 ID");
        const projectId = await this.resolveRemoteProjectId(task.projectId || "inbox");
        const res = await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl(`/project/${projectId}/task/${task.didaId}/complete`), {
            method: "POST"
        } as any);
        if (!res.ok) throw new Error("完成任务失败: " + res.status);
        task.status = 2;
        ensureTaskCompletedTime(task);
    }

    private async readResponseJson<T>(res: { text?: () => Promise<string>; json?: () => Promise<any> }, fallback: T): Promise<T> {
        if (typeof res.text === "function") {
            const text = await res.text();
            if (!text) return fallback;
            try {
                return JSON.parse(text) as T;
            } catch (_error) {
                if (typeof res.json === "function") {
                    try {
                        return await res.json();
                    } catch (_jsonError) {
                        return fallback;
                    }
                }
                return fallback;
            }
        }
        if (typeof res.json === "function") {
            try {
                return await res.json();
            } catch (_error) {
                return fallback;
            }
        }
        return fallback;
    }

    async deleteTaskInDidaList(taskId: string, projectId: string = "inbox", trackPending: boolean = true) {
        const remoteProjectId = await this.resolveRemoteProjectId(projectId);
        const task = this.plugin.settings.tasks.find(item => item.didaId === taskId) || {
            id: taskId,
            didaId: taskId,
            projectId,
            title: "",
            content: "",
            status: 0
        } as DidaTask;
        if (trackPending) await this.queueOperation(task, "delete");
        try {
            const res = await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl(`/project/${remoteProjectId}/task/${taskId}`), {
                method: "DELETE"
            } as any);
            if (!res.ok) throw new Error("删除任务失败: " + res.status);
            await this.clearOperation(task);
        } catch (e) {
            if (trackPending) await this.markOperationFailed(task, e);
            throw e;
        }
    }

    normalizeTaskDateForMatch(value: any): string {
        if (!value || typeof value !== "string") return "";
        const match = value.match(/\d{4}-\d{2}-\d{2}/);
        return match ? match[0] : value;
    }

    normalizeProjectIdForMatch(value: any): string {
        return this.normalizeRemoteProjectId(value);
    }

    findLocalRepeatTaskCopyIndex(remote: any): number {
        if (!remote || !remote.repeatFlag || !remote.title) return -1;
        const remoteProjectId = this.normalizeProjectIdForMatch(remote.projectId);
        const remoteDueDate = this.normalizeTaskDateForMatch(remote.dueDate || remote.startDate);
        if (!remoteDueDate) return -1;

        return this.plugin.settings.tasks.findIndex((local: DidaTask) => {
            if (!local || local.didaId || local.status === 2) return false;
            if (!local.repeatFlag || local.repeatFlag !== remote.repeatFlag) return false;
            if ((local.title || "").trim() !== String(remote.title || "").trim()) return false;
            if (this.normalizeProjectIdForMatch(local.projectId) !== remoteProjectId) return false;
            const localDueDate = this.normalizeTaskDateForMatch(local.dueDate || local.startDate);
            return !!localDueDate && localDueDate === remoteDueDate;
        });
    }

    async mergeRemoteRepeatTaskIntoLocalCopy(index: number, remote: any, project: any = null) {
        const local = this.plugin.settings.tasks[index];
        if (!local) return null;

        local.didaId = remote.id;
        local.projectId = this.normalizeRemoteProjectId(remote.projectId);
        local.projectName = project ? project.name : remote.projectName || local.projectName;
        local.createdAt = remote.createdTime || local.createdAt || new Date().toISOString();
        local.updatedAt = new Date().toISOString();
        local.dueDate = remote.dueDate || null;
        local.startDate = remote.startDate || null;
        local.timeZone = remote.timeZone || local.timeZone;
        local.modifiedTime = remote.modifiedTime || local.modifiedTime;
        local.etag = remote.etag || null;
        local.isAllDay = remote.isAllDay || false;
        local.kind = remote.kind || local.kind || "TEXT";
        local.reminders = remote.reminders || [];
        local.repeatFlag = remote.repeatFlag || local.repeatFlag || null;
        local.priority = remote.priority || 0;
        local.status = remote.status || 0;
        local.completedTime = normalizeRemoteCompletedTime(remote.completedTime);
        if (local.status === 2) ensureTaskCompletedTime(local);
        local.projectColor = remote.projectColor || project?.color;
        local.projectClosed = remote.projectClosed || project?.closed;
        local.projectViewMode = remote.projectViewMode || project?.viewMode;
        local.projectKind = remote.projectKind || project?.kind;
        local.projectPermission = remote.projectPermission || project?.permission;
        local.parentId = remote.parentId || null;
        if (remote.content !== undefined) local.content = remote.content || "";
        if (remote.desc !== undefined) local.desc = remote.desc || "";
        if (remote.items && Array.isArray(remote.items)) local.items = remote.items;

        await this.plugin.saveSettings();
        await this.clearOperation(local);
        return local;
    }

    async createTaskFromDida(task: any, project: any = null) {
        if (task?.kind === "NOTE") return;
        let content = task.content || "";
        let desc = task.desc || "";
        if (task.items && Array.isArray(task.items) && task.items.length > 0) {
            const merged = content || desc || "";
            content = merged;
            desc = merged;
        }
        const newTask: DidaTask = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            title: task.title,
            content,
            desc,
            didaId: task.id,
            projectId: this.normalizeRemoteProjectId(task.projectId),
            projectName: project ? project.name : task.projectName || "收集箱",
            createdAt: task.createdTime || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            dueDate: task.dueDate || null,
            startDate: task.startDate || null,
            timeZone: task.timeZone,
            modifiedTime: task.modifiedTime,
            etag: task.etag || null,
            isAllDay: task.isAllDay || false,
            kind: task.kind || "TEXT",
            reminders: task.reminders || [],
            repeatFlag: task.repeatFlag || null,
            priority: task.priority || 0,
            status: task.status || 0,
            completedTime: normalizeRemoteCompletedTime(task.completedTime),
            projectColor: task.projectColor || project?.color,
            projectClosed: task.projectClosed || project?.closed,
            projectViewMode: task.projectViewMode || project?.viewMode,
            projectKind: task.projectKind || project?.kind,
            projectPermission: task.projectPermission || project?.permission,
            parentId: task.parentId || null,
            items: task.items && Array.isArray(task.items) ? task.items.map((item: any) => {
                const completedTime = normalizeRemoteCompletedTime(item.completedTime);
                return completedTime ? { ...item, completedTime } : item;
            }) : []
        };
        if (newTask.status === 2) ensureTaskCompletedTime(newTask);
        this.plugin.settings.tasks.push(newTask);
        await this.plugin.saveSettings();
        return newTask;
    }

    async toggleTaskInDidaList(task: DidaTask, trackPending: boolean = true) {
        if (task.didaId) {
            if (trackPending) await this.queueOperation(task, task.status === 2 ? "complete" : "upsert");
            try {
                const projectId = await this.resolveRemoteProjectId(task.projectId || "inbox");
                if (task.status !== 2) {
                    await this.updateTaskInDidaList(task);
                } else {
                    const res = await this.plugin.apiClient.makeAuthenticatedRequest(this.plugin.apiClient.buildApiUrl(`/project/${projectId}/task/${task.didaId}/complete`), {
                        method: "POST"
                    } as any);
                    if (!res.ok) throw new Error("完成任务失败: " + res.status);
                }
                await this.clearOperation(task);
            } catch (e) {
                if (trackPending) await this.markOperationFailed(task, e);
                throw e;
            }
        }
    }

    dispose() {
        this._disposed = true;
        this._rerunRequested = false;
        if (this._reverseCompletionFollowUpTimer) {
            window.clearTimeout(this._reverseCompletionFollowUpTimer);
            this._reverseCompletionFollowUpTimer = null;
        }
        if (this._syncConsistencyFollowUpTimer) {
            window.clearTimeout(this._syncConsistencyFollowUpTimer);
            this._syncConsistencyFollowUpTimer = null;
        }
        this._reverseCompletionFollowUpInProgress = false;
        this._syncConsistencyFollowUpInProgress = false;
        this.isSyncing = false;
        this.setSyncState({ phase: "idle", isRunning: false, queued: false, finishedAt: new Date().toISOString(), message: "同步已停止" });
    }

    // ==================== Reverse Completion Verification ====================

    _getReverseCompletionMeta(didaId: string) {
        if (!this.plugin.settings.reverseCompletionMeta || typeof this.plugin.settings.reverseCompletionMeta !== "object") {
            this.plugin.settings.reverseCompletionMeta = {};
        }
        let meta = this.plugin.settings.reverseCompletionMeta[didaId];
        if (!meta) {
            meta = { missingStreak: 0, lastSeenAt: null, lastMissingAt: null };
            this.plugin.settings.reverseCompletionMeta[didaId] = meta;
        }
        return meta;
    }

    _refreshReverseCompletionSeenMeta(tasks: any[]) {
        if (!Array.isArray(tasks) || tasks.length === 0) return;
        const now = new Date().toISOString();
        for (const task of tasks) {
            if (task && task.id) {
                const meta = this._getReverseCompletionMeta(task.id);
                meta.lastSeenAt = now;
                meta.missingStreak = 0;
            }
        }
    }

    async _verifySingleDidaTaskStatus(projectId: string, didaId: string): Promise<{ kind: string; data?: any; httpStatus?: number; error?: any }> {
        if (!didaId) return { kind: "uncertain" };
        try {
            const remoteProjectId = await this.resolveRemoteProjectId(projectId || "inbox");
            const url = this.plugin.apiClient.buildApiUrl(`/project/${remoteProjectId}/task/${didaId}`);
            const res = await this.plugin.apiClient.makeAuthenticatedRequest(url);
            if (res.status === 404) return { kind: "not_found" };
            if (res.ok) {
                let data = null;
                try {
                    data = await res.json();
                } catch (e) {
                    data = null;
                }
                return data && typeof data === "object"
                    ? data.status === 2
                        ? { kind: "completed", data }
                        : { kind: "still_active", data }
                    : { kind: "uncertain" };
            }
            return { kind: "uncertain", httpStatus: res.status };
        } catch (e) {
            return { kind: "uncertain", error: e };
        }
    }

    async _decideReverseCompletion(task: any, context?: { verifyBudget?: { value: number }; decisionCache?: Map<string, boolean> }) {
        if (context && context.decisionCache && context.decisionCache.has(task.didaId)) {
            return context.decisionCache.get(task.didaId);
        }
        const meta = this._getReverseCompletionMeta(task.didaId);
        const updateMeta = (result: boolean) => {
            if (context && context.decisionCache) {
                context.decisionCache.set(task.didaId, result);
            }
            return result;
        };
        meta.missingStreak = (meta.missingStreak || 0) + 1;
        meta.lastMissingAt = new Date().toISOString();
        if (meta.missingStreak < REVERSE_COMPLETION_MISSING_THRESHOLD) return updateMeta(false);
        const budget = context && context.verifyBudget;
        if (!budget || budget.value <= 0) return updateMeta(false);
        budget.value--;
        const result = await this._verifySingleDidaTaskStatus(task.projectId, task.didaId);
        switch (result.kind) {
            case "completed":
                task.remoteDeleted = false;
                return updateMeta(true);
            case "not_found":
                task.remoteDeleted = true;
                return updateMeta(true);
            case "still_active":
                task.remoteDeleted = false;
                meta.missingStreak = 0;
                return updateMeta(false);
            default:
                return updateMeta(false);
        }
    }

    _collectReverseCompletionCandidates(): Array<{ didaId: string; projectId: string }> {
        const meta = this.plugin.settings && this.plugin.settings.reverseCompletionMeta;
        if (!meta || typeof meta !== "object" || Object.keys(meta).length === 0) return [];
        const taskMap = new Map<string, any>();
        for (const task of this.plugin.settings.tasks) {
            if (task && task.didaId) taskMap.set(task.didaId, task);
        }
        const candidates: Array<{ didaId: string; projectId: string }> = [];
        for (const didaId of Object.keys(meta)) {
            const m = meta[didaId];
            if (!m || typeof m !== "object") continue;
            const missingStreak = m.missingStreak || 0;
            if (missingStreak < 1 || missingStreak >= REVERSE_COMPLETION_MISSING_THRESHOLD) continue;
            const task = taskMap.get(didaId);
            if (task && task.status !== 2) {
                candidates.push({ didaId, projectId: task.projectId });
            }
        }
        return candidates;
    }

    async _runReverseCompletionFollowUpPass(tasks: Array<{ didaId: string; projectId: string }>, verifyBudget: { value: number }, pass: number) {
        const toRetry: Array<{ didaId: string; projectId: string }> = [];
        const toConfirm: Array<{ didaId: string; projectId: string }> = [];
        for (const task of tasks) {
            if (verifyBudget.value <= 0) {
                toRetry.push(task);
                continue;
            }
            const localTask = this.plugin.settings.tasks.find((t: any) => t && t.didaId === task.didaId);
            if (localTask && localTask.status !== 2) {
                verifyBudget.value--;
                let result = { kind: "uncertain" };
                try {
                    result = await this._verifySingleDidaTaskStatus(task.projectId, task.didaId);
                } catch (e) {
                    result = { kind: "uncertain", error: e };
                }
                const meta = this._getReverseCompletionMeta(task.didaId);
                switch (result.kind) {
                    case "still_active":
                        meta.missingStreak = 0;
                        meta.lastSeenAt = new Date().toISOString();
                        break;
                    case "completed":
                        localTask.remoteDeleted = false;
                        meta.missingStreak = (meta.missingStreak || 0) + 1;
                        meta.lastMissingAt = new Date().toISOString();
                        if (meta.missingStreak >= REVERSE_COMPLETION_MISSING_THRESHOLD) {
                            toConfirm.push(task);
                        } else {
                            toRetry.push(task);
                        }
                        break;
                    case "not_found":
                        localTask.remoteDeleted = true;
                        meta.missingStreak = (meta.missingStreak || 0) + 1;
                        meta.lastMissingAt = new Date().toISOString();
                        if (meta.missingStreak >= REVERSE_COMPLETION_MISSING_THRESHOLD) {
                            toConfirm.push(task);
                        } else {
                            toRetry.push(task);
                        }
                        break;
                    default:
                        toRetry.push(task);
                }
            }
        }
        if (toConfirm.length > 0) {
            await this._confirmReverseCompletionTasks(toConfirm);
        }
        return toRetry;
    }

    async _confirmReverseCompletionTasks(tasks: Array<{ didaId: string; projectId: string }>) {
        for (const task of tasks) {
            const localTask = this.plugin.settings.tasks.find((t: any) => t && t.didaId === task.didaId);
            if (localTask && localTask.status !== 2) {
                if (!localTask.remoteDeleted) {
                    localTask.status = 2;
                    ensureTaskCompletedTime(localTask);
                }
                localTask.updatedAt = new Date().toISOString();
                await this.plugin.saveSettings();
            }
        }
        if (tasks.length > 0) {
            this.plugin.refreshTaskView();
        }
    }

    _scheduleReverseCompletionFollowUp() {
        if (this._reverseCompletionFollowUpInProgress) return;
        const candidates = this._collectReverseCompletionCandidates();
        if (!candidates || candidates.length === 0) return;
        if (this._reverseCompletionFollowUpTimer) {
            clearTimeout(this._reverseCompletionFollowUpTimer);
            this._reverseCompletionFollowUpTimer = null;
        }
        let pass = 0;
        const tasks = candidates.slice();
        const verifyBudget = { value: REVERSE_COMPLETION_MAX_VERIFY_PER_SYNC };
        const runPass = async () => {
            if (!this._isPluginAliveForFollowUp()) return;
            this._reverseCompletionFollowUpTimer = null;
            this._reverseCompletionFollowUpInProgress = true;
            try {
                pass++;
                tasks.slice();
                const remaining = await this._runReverseCompletionFollowUpPass(tasks, verifyBudget, pass);
                tasks.length = 0;
                tasks.push(...remaining);
            } catch (e) {
            } finally {
                this._reverseCompletionFollowUpInProgress = false;
            }
            if (this._isPluginAliveForFollowUp() && tasks.length > 0 && pass < REVERSE_COMPLETION_MAX_FOLLOWUP_PASSES) {
                this._reverseCompletionFollowUpTimer = window.setTimeout(runPass, REVERSE_COMPLETION_FOLLOWUP_DELAY_MS);
            }
        };
        this._reverseCompletionFollowUpTimer = window.setTimeout(runPass, REVERSE_COMPLETION_FOLLOWUP_DELAY_MS);
    }

    _isPluginAliveForFollowUp(): boolean {
        return !!(this && this.plugin && this.plugin.settings && Array.isArray(this.plugin.settings.tasks));
    }

    // ==================== Sync Consistency Follow-up ====================

    _scheduleSyncConsistencyFollowUp() {
        if (this._syncConsistencyFollowUpInProgress) return;
        const meta = this.plugin.settings && this.plugin.settings.syncConsistencyMeta;
        if (!meta || Object.keys(meta).length === 0) return;
        if (this._syncConsistencyFollowUpTimer) {
            clearTimeout(this._syncConsistencyFollowUpTimer);
            this._syncConsistencyFollowUpTimer = null;
        }
        const verifyBudget = { value: 20 };
        const runPass = async () => {
            if (!this._isPluginAliveForFollowUp()) return;
            this._syncConsistencyFollowUpTimer = null;
            this._syncConsistencyFollowUpInProgress = true;
            try {
                await this._runSyncConsistencyFollowUpPass(verifyBudget);
            } catch (e) {
            } finally {
                this._syncConsistencyFollowUpInProgress = false;
            }
        };
        this._syncConsistencyFollowUpTimer = window.setTimeout(runPass, 2000);
    }

    async _runSyncConsistencyFollowUpPass(verifyBudget: { value: number }): Promise<boolean> {
        const meta = this.plugin.settings && this.plugin.settings.syncConsistencyMeta;
        if (!meta) return false;
        const keys = Object.keys(meta);
        if (keys.length === 0) return false;
        let needsRetry = false;
        let madeChanges = false;
        for (const didaId of keys) {
            if (verifyBudget.value <= 0) {
                needsRetry = true;
                continue;
            }
            const record = meta[didaId];
            if (!record || (!record.title && !record.date)) {
                delete meta[didaId];
                madeChanges = true;
                continue;
            }
            const task = this.plugin.settings.tasks.find((t: any) => t && t.didaId === didaId);
            if (task) {
                verifyBudget.value--;
                let result = { kind: "uncertain" };
                try {
                    result = await this._verifySingleDidaTaskStatus(task.projectId, didaId);
                } catch (e) {
                    result = { kind: "uncertain", error: e };
                }
                if (result.kind === "uncertain") {
                    needsRetry = true;
                } else if (result.kind === "not_found") {
                    delete meta[didaId];
                    madeChanges = true;
                } else {
                    const data = result.data || {};
                    if (record.title) {
                        const titleSettled = await this._reconcileTitleConsistency(task, record.title, data);
                        if (titleSettled === "settled") {
                            delete record.title;
                            madeChanges = true;
                        } else {
                            needsRetry = true;
                        }
                    }
                    if (record.date) {
                        const dateSettled = await this._reconcileDateConsistency(task, record.date, data);
                        if (dateSettled === "settled") {
                            delete record.date;
                            madeChanges = true;
                        } else {
                            needsRetry = true;
                        }
                    }
                    if (!record.title && !record.date) {
                        delete meta[didaId];
                        madeChanges = true;
                    }
                }
            } else {
                delete meta[didaId];
                madeChanges = true;
            }
        }
        if (madeChanges) {
            await this.plugin.saveSettings();
        }
        return !needsRetry;
    }

    async _reconcileTitleConsistency(task: any, expectedTitle: string, remoteData: any): Promise<"settled" | "retry" | "uncertain"> {
        if (!task || !expectedTitle) return "settled";
        const localTitle = (task.title || "").trim();
        const normalizedLocal = localTitle.replace(/\s+/g, " ");
        const normalizedExpected = expectedTitle.replace(/\s+/g, " ");
        if (normalizedLocal === normalizedExpected) return "settled";
        return "retry";
    }

    async _reconcileDateConsistency(task: any, expectedDate: string, remoteData: any): Promise<"settled" | "retry" | "uncertain"> {
        if (!task || !expectedDate) return "settled";
        const localDue = task.dueDate || "";
        if (localDue && localDue.includes(expectedDate)) return "settled";
        return "retry";
    }

    _recordTitleConsistencyExpectation(didaId: string, title: string, direction: "forward" | "reverse") {
        if (!this.plugin.settings.syncConsistencyMeta) {
            this.plugin.settings.syncConsistencyMeta = {};
        }
        if (!this.plugin.settings.syncConsistencyMeta[didaId]) {
            this.plugin.settings.syncConsistencyMeta[didaId] = {};
        }
        this.plugin.settings.syncConsistencyMeta[didaId].title = title;
    }

    _recordDateConsistencyExpectation(didaId: string, task: any, direction: "forward" | "reverse") {
        if (!this.plugin.settings.syncConsistencyMeta) {
            this.plugin.settings.syncConsistencyMeta = {};
        }
        if (!this.plugin.settings.syncConsistencyMeta[didaId]) {
            this.plugin.settings.syncConsistencyMeta[didaId] = {};
        }
        const date = task.dueDate || task.startDate;
        if (date) {
            const dateMatch = date.match(/\d{4}-\d{2}-\d{2}/);
            if (dateMatch) {
                this.plugin.settings.syncConsistencyMeta[didaId].date = dateMatch[0];
            }
        }
    }
}
