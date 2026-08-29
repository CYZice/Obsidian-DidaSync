import { DidaNoteSyncSummary, SyncFailureDetail, SyncResult, SyncRunRequest, SyncRunScope, SyncScopeResult } from "../types";
import { SyncRunContext, SyncRunCoordinator } from "./SyncRunCoordinator";

interface UnifiedTaskScope {
    runTaskScope(context: SyncRunContext): Promise<SyncResult>;
}

interface UnifiedNoteScope {
    syncNow(options: { silent?: boolean; suppressNoopNotice?: boolean; source?: SyncRunRequest["source"] }): Promise<DidaNoteSyncSummary>;
}

interface UnifiedSyncEngineOptions {
    taskScope: UnifiedTaskScope;
    noteScope: UnifiedNoteScope;
    shouldRunNotes(): boolean;
    scanLocalDeletions?(): Promise<number>;
    onStateChange?(): void;
    onTimeout?(error: Error): void;
}

const SYNC_RUN_TIMEOUT_MS = 90000;

export class UnifiedSyncEngine {
    private pendingRequest: SyncRunRequest | null = null;
    private coordinator: SyncRunCoordinator<SyncResult>;

    constructor(private options: UnifiedSyncEngineOptions) {
        this.coordinator = new SyncRunCoordinator<SyncResult>({
            timeoutMs: SYNC_RUN_TIMEOUT_MS,
            createSkippedResult: () => this.emptyResult("skipped"),
            createFailureResult: error => ({
                ...this.emptyResult("failed"),
                failedOperations: [error instanceof Error ? error.message : String(error)]
            }),
            mergeResults: (current, next) => this.mergeResults(current, next),
            runOnce: context => this.runOnce(context),
            onStateChange: () => this.options.onStateChange?.(),
            onTimeout: error => this.options.onTimeout?.(error)
        });
    }

    get isRunning() {
        return this.coordinator.isRunning;
    }

    getState() {
        return this.coordinator.getState();
    }

    run(request: SyncRunRequest): Promise<SyncResult> {
        this.pendingRequest = this.coordinator.isRunning && this.pendingRequest
            ? this.mergeRequest(this.pendingRequest, request)
            : request;
        return this.coordinator.run();
    }

    dispose() {
        this.coordinator.dispose();
    }

    private async runOnce(context: SyncRunContext): Promise<SyncResult> {
        const request = this.pendingRequest || { source: "manual", scope: "all" };
        this.pendingRequest = null;
        const scopeResults: SyncScopeResult[] = [];
        let taskResult = this.emptyResult("skipped");
        let noteSummary: DidaNoteSyncSummary | undefined;

        context.setPhase("scanning", "正在扫描本地修改");
        await this.options.scanLocalDeletions?.();
        if (request.scope === "all" || request.scope === "tasks") {
            try {
                taskResult = await this.options.taskScope.runTaskScope(context);
                scopeResults.push({
                    key: "tasks",
                    entityKind: "task",
                    outcome: taskResult.outcome,
                    pulled: taskResult.downloaded,
                    pushed: taskResult.uploaded,
                    failures: taskResult.failedDetails || this.failuresFromStrings(taskResult.failedScopes, "task-snapshot")
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                taskResult = { ...this.emptyResult("failed"), failedScopes: [reason] };
                scopeResults.push({ key: "tasks", entityKind: "task", outcome: "failed", pulled: 0, pushed: 0, failures: [{ operation: "task-scope", reason }] });
            }
        }

        if ((request.scope === "all" || request.scope === "notes") && this.options.shouldRunNotes()) {
            context.setPhase("fetching", "正在拉取云端笔记");
            try {
                noteSummary = await this.options.noteScope.syncNow({
                    silent: request.silent === true,
                    suppressNoopNotice: request.silent !== true,
                    source: request.source
                });
                scopeResults.push({
                    key: "notes",
                    entityKind: "note",
                    outcome: noteSummary.outcome,
                    pulled: noteSummary.synced,
                    pushed: noteSummary.pushed,
                    failures: noteSummary.errors.map(reason => ({ operation: "note-sync", reason }))
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                scopeResults.push({ key: "notes", entityKind: "note", outcome: "failed", pulled: 0, pushed: 0, failures: [{ operation: "note-scope", reason }] });
            }
        }

        const noteScope = scopeResults.find(scope => scope.key === "notes");
        const failedDetails = [
            ...(taskResult.failedDetails || []),
            ...(noteScope?.failures || [])
        ];
        const failedScopes = [
            ...taskResult.failedScopes,
            ...(noteScope && (noteScope.outcome === "failed" || noteScope.outcome === "partial") ? ["notes"] : [])
        ];
        const outcome = this.resolveOutcome(scopeResults);
        context.setPhase("verifying", "正在核对同步结果");
        context.setPhase(outcome === "failed" ? "failed" : "completed", outcome === "success" ? "同步完成" : outcome === "partial" ? "部分同步失败" : "同步失败");
        return {
            outcome,
            uploaded: taskResult.uploaded + (noteSummary?.pushed || 0),
            downloaded: taskResult.downloaded + (noteSummary?.synced || 0),
            failedScopes,
            failedOperations: [...taskResult.failedOperations, ...(noteSummary?.errors || [])],
            failedDetails,
            cleanupPerformed: taskResult.cleanupPerformed,
            scopeResults,
            noteSummary
        };
    }

    private emptyResult(outcome: SyncResult["outcome"]): SyncResult {
        return { outcome, uploaded: 0, downloaded: 0, failedScopes: [], failedOperations: [], cleanupPerformed: false, scopeResults: [] };
    }

    private mergeRequest(current: SyncRunRequest, next: SyncRunRequest): SyncRunRequest {
        const scope: SyncRunScope = current.scope === next.scope ? next.scope : "all";
        return { source: next.source, scope, silent: current.silent === true && next.silent === true };
    }

    private mergeResults(current: SyncResult, next: SyncResult): SyncResult {
        const failedScopes = [...current.failedScopes, ...next.failedScopes];
        const failedOperations = [...current.failedOperations, ...next.failedOperations];
        const failedDetails = [...(current.failedDetails || []), ...(next.failedDetails || [])];
        const scopeResults = [...(current.scopeResults || []), ...(next.scopeResults || [])];
        return {
            outcome: this.resolveOutcome(scopeResults),
            uploaded: current.uploaded + next.uploaded,
            downloaded: current.downloaded + next.downloaded,
            failedScopes,
            failedOperations,
            failedDetails,
            cleanupPerformed: current.cleanupPerformed || next.cleanupPerformed,
            scopeResults,
            noteSummary: next.noteSummary || current.noteSummary
        };
    }

    private resolveOutcome(scopes: SyncScopeResult[]): SyncResult["outcome"] {
        if (scopes.length === 0 || scopes.every(scope => scope.outcome === "skipped")) return "skipped";
        const successful = scopes.some(scope => scope.outcome === "success" || scope.outcome === "partial");
        const failed = scopes.some(scope => scope.outcome === "failed" || scope.outcome === "partial");
        if (failed && successful) return "partial";
        return failed ? "failed" : "success";
    }

    private failuresFromStrings(reasons: string[], operation: string): SyncFailureDetail[] {
        return reasons.map(reason => ({ operation, reason }));
    }
}
