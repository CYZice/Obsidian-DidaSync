import { App, normalizePath, TFile } from "obsidian";
import { DidaSyncSettings, SyncDeletionCandidate } from "../types";

interface LocalDeletionHost {
    settings: DidaSyncSettings;
    saveSettings(): Promise<void>;
}

export class LocalDeletionTracker {
    constructor(private app: App, private host: LocalDeletionHost) { }

    list(): SyncDeletionCandidate[] {
        if (!Array.isArray(this.host.settings.syncDeletionCandidates)) this.host.settings.syncDeletionCandidates = [];
        return this.host.settings.syncDeletionCandidates;
    }

    async scan(): Promise<number> {
        const detected = new Map<string, SyncDeletionCandidate>();
        const detached = new Set(Array.isArray(this.host.settings.detachedSyncEntities) ? this.host.settings.detachedSyncEntities : []);
        const existing = new Map(this.list().map(candidate => [candidate.id, candidate]));
        const previousLinkIndex = this.host.settings.nativeTaskLinkIndex || {};
        const currentLinkIndex: DidaSyncSettings["nativeTaskLinkIndex"] = {};

        for (const file of this.app.vault.getMarkdownFiles()) {
            const content = await this.app.vault.cachedRead(file);
            const matches = content.matchAll(/obsidian:\/\/dida-task\?didaId=([^)&\s]+)/g);
            for (const match of matches) {
                const remoteId = decodeURIComponent(match[1]);
                if (detached.has(`task:${remoteId}`)) continue;
                const task = (this.host.settings.tasks || []).find(item => item.didaId === remoteId);
                const previous = previousLinkIndex[remoteId];
                currentLinkIndex[remoteId] = previous?.path === file.path ? previous : {
                    remoteId,
                    path: file.path,
                    title: task?.title || previousLinkIndex[remoteId]?.title || remoteId,
                    lastSeenAt: new Date().toISOString()
                };
            }
        }

        for (const [remoteId, previous] of Object.entries(previousLinkIndex)) {
            const key = `task:${remoteId}`;
            const task = (this.host.settings.tasks || []).find(item => item.didaId === remoteId);
            if (!task || detached.has(key) || currentLinkIndex[remoteId]) continue;
            const file = this.app.vault.getAbstractFileByPath(normalizePath(previous.path));
            detected.set(key, existing.get(key) || {
                id: key,
                entityKind: "task",
                remoteId,
                localId: task.id,
                path: previous.path,
                projectId: task.projectId,
                title: task.title || previous.title,
                reason: file instanceof TFile ? "local_task_line_missing" : "local_file_missing",
                detectedAt: new Date().toISOString()
            });
        }

        for (const record of this.host.settings.didaNoteSyncRecords || []) {
            const key = `note:${record.didaId}`;
            if (detached.has(key)) continue;
            const file = record.path ? this.app.vault.getAbstractFileByPath(normalizePath(record.path)) : null;
            if (file instanceof TFile) continue;
            detected.set(key, existing.get(key) || {
                id: key,
                entityKind: "note",
                remoteId: record.didaId,
                path: record.path,
                projectId: record.projectId,
                title: record.title,
                reason: "local_file_missing",
                detectedAt: new Date().toISOString()
            });
        }

        for (const task of this.host.settings.tasks || []) {
            if (!task.didaId || !task.hasLink || !task.linkPath) continue;
            const key = `task:${task.didaId}`;
            if (detached.has(key)) continue;
            const path = normalizePath(task.linkPath);
            const file = this.app.vault.getAbstractFileByPath(path);
            let reason: SyncDeletionCandidate["reason"] | null = null;
            if (!(file instanceof TFile)) {
                reason = "local_file_missing";
            } else {
                const content = await this.app.vault.cachedRead(file);
                const encodedId = encodeURIComponent(task.didaId);
                if (!content.includes(`didaId=${task.didaId}`) && !content.includes(`didaId=${encodedId}`)) reason = "local_task_line_missing";
            }
            if (!reason) continue;
            detected.set(key, existing.get(key) || {
                id: key,
                entityKind: "task",
                remoteId: task.didaId,
                localId: task.id,
                path,
                projectId: task.projectId,
                title: task.title,
                reason,
                detectedAt: new Date().toISOString()
            });
        }

        const nextLinkIndex = { ...previousLinkIndex, ...currentLinkIndex };
        Object.keys(nextLinkIndex).forEach(remoteId => {
            const taskExists = (this.host.settings.tasks || []).some(task => task.didaId === remoteId);
            if (!taskExists && !currentLinkIndex[remoteId]) delete nextLinkIndex[remoteId];
        });
        const next = [...detected.values()];
        const changed = JSON.stringify(this.list()) !== JSON.stringify(next)
            || JSON.stringify(previousLinkIndex) !== JSON.stringify(nextLinkIndex);
        this.host.settings.syncDeletionCandidates = next;
        this.host.settings.nativeTaskLinkIndex = nextLinkIndex;
        if (changed) await this.host.saveSettings();
        return next.length;
    }

    async detach(candidate: SyncDeletionCandidate) {
        const key = `${candidate.entityKind}:${candidate.remoteId}`;
        if (!Array.isArray(this.host.settings.detachedSyncEntities)) this.host.settings.detachedSyncEntities = [];
        if (!this.host.settings.detachedSyncEntities.includes(key)) this.host.settings.detachedSyncEntities.push(key);
        if (candidate.entityKind === "note") {
            const file = candidate.path ? this.app.vault.getAbstractFileByPath(normalizePath(candidate.path)) : null;
            if (file instanceof TFile) {
                const content = await this.app.vault.read(file);
                await this.app.vault.modify(file, content.replace(/^dida[A-Za-z0-9]+:.*(?:\r?\n|$)/gm, ""));
            }
            this.host.settings.didaNoteSyncRecords = (this.host.settings.didaNoteSyncRecords || []).filter(record => record.didaId !== candidate.remoteId);
        } else {
            const task = (this.host.settings.tasks || []).find(item => item.didaId === candidate.remoteId);
            const file = candidate.path ? this.app.vault.getAbstractFileByPath(normalizePath(candidate.path)) : null;
            if (file instanceof TFile) {
                const content = await this.app.vault.read(file);
                const escapedId = candidate.remoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const linkPattern = new RegExp(`\\s*\\[🔗Dida\\]\\(obsidian:\\/\\/dida-task\\?didaId=${escapedId}\\)`, "g");
                await this.app.vault.modify(file, content.replace(linkPattern, ""));
            }
            if (task) {
                task.hasLink = false;
                task.linkPath = undefined;
            }
        }
        await this.complete(candidate.id);
    }

    async complete(candidateId: string) {
        const candidate = this.list().find(item => item.id === candidateId);
        if (candidate?.entityKind === "task" && this.host.settings.nativeTaskLinkIndex) {
            delete this.host.settings.nativeTaskLinkIndex[candidate.remoteId];
        }
        this.host.settings.syncDeletionCandidates = this.list().filter(candidate => candidate.id !== candidateId);
        await this.host.saveSettings();
    }
}
