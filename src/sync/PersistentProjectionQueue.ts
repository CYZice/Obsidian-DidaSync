import { DidaSyncSettings, SyncProjectionOperation } from "../types";

interface ProjectionQueueHost {
    settings: DidaSyncSettings;
    saveSettings(): Promise<void>;
}

export class PersistentProjectionQueue {
    constructor(private host: ProjectionQueueHost) { }

    list(): SyncProjectionOperation[] {
        if (!Array.isArray(this.host.settings.pendingSyncProjections)) this.host.settings.pendingSyncProjections = [];
        return this.host.settings.pendingSyncProjections;
    }

    enqueueTask(remoteId: string, path: string | undefined, payload: Record<string, unknown>) {
        const id = `task:${remoteId}`;
        const existing = this.list().find(operation => operation.id === id);
        if (existing) {
            existing.path = path || existing.path;
            existing.payload = { ...(existing.payload || {}), ...payload };
            existing.lastError = undefined;
            return;
        }
        this.list().push({
            id,
            entityKind: "task",
            remoteId,
            path,
            operation: "update",
            payload,
            createdAt: new Date().toISOString(),
            attempts: 0
        });
    }

    async remove(operation: SyncProjectionOperation) {
        this.host.settings.pendingSyncProjections = this.list().filter(item => item !== operation);
        await this.host.saveSettings();
    }

    async markFailed(operation: SyncProjectionOperation, error: unknown) {
        operation.attempts += 1;
        operation.lastError = error instanceof Error ? error.message : String(error);
        await this.host.saveSettings();
    }
}
