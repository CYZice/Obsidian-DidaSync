import { DidaSyncSettings, DidaTask, PendingSyncOperation, PendingSyncOperationType } from "../types";

interface SyncOutboxHost {
    settings: DidaSyncSettings;
    saveSettings(): Promise<void>;
}

export class SyncOutbox {
    constructor(private host: SyncOutboxHost) { }

    list(): PendingSyncOperation[] {
        if (!Array.isArray(this.host.settings.pendingSyncOperations)) this.host.settings.pendingSyncOperations = [];
        return this.host.settings.pendingSyncOperations;
    }

    findForTask(task: DidaTask): PendingSyncOperation | undefined {
        return this.list().find(operation => operation.localTaskId === task.id || (!!task.didaId && operation.didaId === task.didaId));
    }

    hasForTask(task: DidaTask): boolean {
        return !!this.findForTask(task);
    }

    hasDelete(remoteId: string): boolean {
        return this.list().some(operation => operation.didaId === remoteId && operation.type === "delete");
    }

    isDue(operation: PendingSyncOperation, now: number = Date.now()): boolean {
        if (operation.state === "permanent_failure") return false;
        if (!operation.nextRetryAt) return true;
        const retryAt = Date.parse(operation.nextRetryAt);
        return !Number.isFinite(retryAt) || retryAt <= now;
    }

    async enqueue(task: DidaTask, type: PendingSyncOperationType, payload?: PendingSyncOperation["payload"]) {
        const operations = this.list();
        const existing = operations.find(operation => operation.localTaskId === task.id);
        const modifiedAt = new Date().toISOString();
        const next: PendingSyncOperation = {
            localTaskId: task.id,
            didaId: task.didaId,
            projectId: task.projectId || "inbox",
            type,
            payload: type === "delete" ? undefined : (payload || { ...task }),
            createdAt: existing?.createdAt || modifiedAt,
            modifiedAt,
            attempts: existing?.attempts || 0,
            state: "pending",
            fingerprint: this.fingerprint(task.id, type, payload || task)
        };
        this.host.settings.pendingSyncOperations = operations.filter(operation => operation.localTaskId !== task.id);
        this.host.settings.pendingSyncOperations.push(next);
        await this.host.saveSettings();
    }

    async remove(operation: PendingSyncOperation) {
        this.host.settings.pendingSyncOperations = this.list().filter(item => item !== operation);
        await this.host.saveSettings();
    }

    async removeForTask(task: DidaTask): Promise<boolean> {
        const current = this.list();
        const remaining = current.filter(operation => operation.localTaskId !== task.id && (!task.didaId || operation.didaId !== task.didaId));
        if (remaining.length === current.length) return false;
        this.host.settings.pendingSyncOperations = remaining;
        await this.host.saveSettings();
        return true;
    }

    async markStarted(operation: PendingSyncOperation) {
        operation.requestStartedAt = new Date().toISOString();
        operation.state = "uncertain";
        operation.lastError = undefined;
        await this.host.saveSettings();
    }

    async markFailed(operation: PendingSyncOperation, error: unknown) {
        operation.attempts += 1;
        operation.lastError = error instanceof Error ? error.message : String(error);
        operation.state = operation.attempts >= 8 ? "permanent_failure" : "uncertain";
        const delayMs = Math.min(5 * 60_000, 1000 * Math.pow(2, Math.min(operation.attempts, 8)));
        operation.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        await this.host.saveSettings();
    }

    async block(operation: PendingSyncOperation, reason: string) {
        operation.state = "permanent_failure";
        operation.lastError = reason;
        operation.nextRetryAt = undefined;
        await this.host.saveSettings();
    }

    private fingerprint(localTaskId: string, type: PendingSyncOperationType, payload: unknown): string {
        const source = `${localTaskId}:${type}:${JSON.stringify(payload || null)}`;
        let hash = 2166136261;
        for (let index = 0; index < source.length; index++) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    }
}
