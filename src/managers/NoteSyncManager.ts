import { App, normalizePath, Notice, TAbstractFile, TFile } from "obsidian";
import DidaSyncPlugin from "../main";
import { DUPLICATE_LOCAL_FILE_MARKER, DidaNoteSyncRecord, DidaNoteSyncRunSource, DidaNoteSyncStatus, DidaNoteSyncSummary, DidaTask, INBOX_PROJECT_NAME } from "../types";
import { resolveWholeEntityConflict } from "../sync/WholeEntityConflictPolicy";
import { LocalDeletionTracker } from "../sync/LocalDeletionTracker";
import { NoteFileLocator } from "../sync/NoteFileLocator";
import { ParsedNoteFile, parseNoteFile, renderNoteDocument } from "../noteDocument";
import { UNTITLED_NOTE_STEM, buildConflictStem, hasLeadingTitleHeading, sanitizeNoteFilenameStem, stripLeadingTitleHeading } from "../noteFilename";

interface NoteSyncOptions {
    silent?: boolean;
    suppressNoopNotice?: boolean;
    source?: DidaNoteSyncRunSource;
}

interface LocalNoteMatch {
    file: TFile;
    parsed: ParsedNoteFile;
}

type NoteSyncOutcome = "synced" | "pushed" | "conflicts" | "skipped";

interface NoteSyncResult {
    result: NoteSyncOutcome;
    renamed: boolean;
}

interface RecordExtraFields {
    localFileStem?: string;
    contentFormat?: "heading" | "plain";
}

/**
 * Persisted, non-localized text. Existing vaults already store this exact string
 * as `record.error`, and duplicate detection relies on it, so it must keep its
 * original wording even though it never appears in the English UI.
 */
const DUPLICATE_LOCAL_FILE_ERROR = "检测到多个本地 Markdown 拥有相同 didaNoteId，请先手动清理重复文件。";

/** A rename event that we caused ourselves is ignored for this long. */
const EXPECTED_RENAME_TTL_MS = 10_000;

export class NoteSyncManager {
    app: App;
    plugin: DidaSyncPlugin;
    private localDeletionTracker: LocalDeletionTracker;
    private noteLocator: NoteFileLocator;
    private expectedRenamePaths = new Map<string, number>();
    private lowerPathCache: Set<string> | null = null;

    constructor(app: App, plugin: DidaSyncPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.localDeletionTracker = new LocalDeletionTracker(app, plugin);
        this.noteLocator = new NoteFileLocator(app, () => this.plugin.settings.didaNoteSyncFolder || "");
    }

    async syncNow(options: NoteSyncOptions = {}): Promise<DidaNoteSyncSummary> {
        const source = options.source || "manual";
        const startedAt = new Date().toISOString();
        const summary = this.createEmptySummary();

        try {
            if (!this.plugin.settings.enableDidaNoteSync) {
                summary.outcome = "skipped";
                summary.summaryText = this.plugin.t("noteSync.disabled");
                return await this.persistSummary(summary, source, startedAt, this.shouldSilenceSummaryNotice(summary, options));
            }
            if (!this.plugin.settings.accessToken) throw new Error(this.plugin.t("error.oauthRequired"));
            if ((this.plugin.settings.didaNoteSyncProjectIds || []).filter(Boolean).length === 0) {
                summary.outcome = "skipped";
                summary.summaryText = this.plugin.t("noteSync.noProjectsSelected");
                return await this.persistSummary(summary, source, startedAt, this.shouldSilenceSummaryNotice(summary, options));
            }

            this.clearCachedNoteTasks();
            this.noteLocator.begin();
            try {
                await this.localDeletionTracker.scan();

                const remoteNotes = await this.fetchRemoteNotes();
                summary.fetched = remoteNotes.length;
                summary.missing = this.markMissingRemoteRecords(remoteNotes);

                for (const note of remoteNotes) {
                    try {
                        const result = await this.syncRemoteNote(note);
                        summary[result.result]++;
                        if (result.renamed) summary.renamed = (summary.renamed || 0) + 1;
                    } catch (error: any) {
                        const message = this.normalizeErrorMessage(error, this.plugin.t("noteSync.failed"));
                        summary.errors.push(message);
                        await this.markNoteError(note, message);
                    }
                }
            } finally {
                this.noteLocator.end();
            }

            summary.outcome = this.resolveSummaryOutcome(summary);
            summary.summaryText = this.formatSyncNotice(summary);
            return await this.persistSummary(summary, source, startedAt, this.shouldSilenceSummaryNotice(summary, options));
        } catch (error: any) {
            const message = this.normalizeErrorMessage(error, this.plugin.t("noteSync.failed"));
            summary.outcome = "failed";
            summary.summaryText = message;
            summary.errors.push(message);
            await this.persistSummary(summary, source, startedAt, true);
            throw error;
        }
    }

    async fetchRemoteNotes(): Promise<DidaTask[]> {
        const projectIds = (this.plugin.settings.didaNoteSyncProjectIds || []).filter(Boolean);
        if (projectIds.length === 0) {
            return [];
        }
        const seen = new Set<string>();
        const notes: DidaTask[] = [];
        for (const projectId of projectIds) {
            const remote = await this.plugin.apiClient.filterTasks({
                kind: ["NOTE"],
                status: [0],
                projectIds: [projectId]
            });
            if (!Array.isArray(remote)) continue;
            const sourceProject = this.getProjectDisplayForSync(projectId);
            remote.forEach((task) => {
                const normalized = this.plugin.normalizeRemoteTask({
                    ...task,
                    projectId: task.projectId || sourceProject.id,
                    projectName: task.projectName || sourceProject.name,
                    projectKind: task.projectKind || sourceProject.kind,
                    projectViewMode: task.projectViewMode || sourceProject.viewMode
                }, sourceProject);
                if (normalized.kind !== "NOTE") return;
                const didaId = normalized.didaId || normalized.id;
                if (didaId && seen.has(didaId)) return;
                if (didaId) seen.add(didaId);
                notes.push(normalized);
            });
        }
        return notes;
    }

    async deleteLocalRecord(didaId: string): Promise<boolean> {
        const records = Array.isArray(this.plugin.settings.didaNoteSyncRecords)
            ? this.plugin.settings.didaNoteSyncRecords
            : [];
        const next = records.filter((record) => record.didaId !== didaId);
        if (next.length === records.length) return false;
        this.plugin.settings.didaNoteSyncRecords = next;
        this.clearCachedNoteTasks(didaId);
        await this.plugin.saveSettings();
        this.plugin.refreshTaskView();
        return true;
    }

    /**
     * Handle a vault rename. Updates the sync record immediately so a rename is
     * never mistaken for a deletion, and reports whether a note sync should run
     * to push the new file name as the remote title.
     */
    async handleFileRename(file: TAbstractFile, oldPath: string): Promise<boolean> {
        try {
            if (!(file instanceof TFile) || file.extension !== "md") return false;
            if (!this.plugin.settings.enableDidaNoteSync) return false;

            const newPath = normalizePath(file.path);
            const newKey = this.normalizeComparablePath(newPath);
            this.pruneExpectedRenames();
            if (this.expectedRenamePaths.has(newKey)) {
                // Rename performed by the plugin itself; the sync loop already
                // updated the record and must not be triggered again.
                this.expectedRenamePaths.delete(newKey);
                return false;
            }

            const oldKey = this.normalizeComparablePath(oldPath || "");
            const records = Array.isArray(this.plugin.settings.didaNoteSyncRecords)
                ? this.plugin.settings.didaNoteSyncRecords
                : [];
            const record = records.find((item) => this.normalizeComparablePath(item.path) === oldKey)
                || records.find((item) => this.normalizeComparablePath(item.path) === newKey);
            if (!record) return false;

            let changed = false;
            if (!record.localFileStem) {
                record.localFileStem = this.stemOfPath(oldPath || record.path);
                changed = true;
            }
            if (this.normalizeComparablePath(record.path) !== newKey) {
                record.path = newPath;
                changed = true;
            }
            if (changed) await this.plugin.saveSettings();

            if (!this.isTitleToFilenameEnabled()) return false;
            if ((this.plugin.settings.detachedSyncEntities || []).includes(`note:${record.didaId}`)) return false;
            return file.basename !== record.localFileStem;
        } catch (_error) {
            return false;
        }
    }

    async forcePullRecord(didaId: string): Promise<boolean> {
        const record = await this.ensureRecord(didaId);
        if (!record) throw new Error(this.plugin.t("noteSync.recordMissing"));
        if (this.isDuplicateLocalFileError(record.error)) throw new Error(record.error || DUPLICATE_LOCAL_FILE_ERROR);

        const remoteNotes = await this.fetchRemoteNotes();
        const remote = remoteNotes.find((note) => (note.didaId || note.id) === didaId);
        if (!remote) {
            record.remoteMissing = true;
            record.status = "missing";
            record.error = this.plugin.t("noteSync.remoteMissing");
            await this.persistManualActionSummary({
                synced: 0,
                pushed: 0,
                summaryText: this.plugin.t("noteSync.remoteMissing")
            });
            return false;
        }

        const body = this.buildLocalMarkdownBody(remote, this.getNoteBody(remote));
        const hash = this.hashMarkdownBody(body);
        const path = record.path || await this.buildNotePath(remote, didaId);
        const file = await this.ensureNoteFile(path, remote);
        const parsed = await this.readParsedFile(file);
        await this.writeSyncedFile(file, remote, body, hash, "synced", parsed);
        let finalFile = file;
        let renamed = false;
        if (this.isTitleToFilenameEnabled()) {
            const desired = await this.renameToDesiredPath(file, remote, didaId);
            finalFile = desired.file;
            renamed = desired.renamed;
        }
        this.upsertRecord(remote, finalFile.path, hash, "synced", undefined, {
            localFileStem: finalFile.basename,
            contentFormat: this.isTitleToFilenameEnabled() ? "plain" : "heading"
        });
        await this.persistManualActionSummary({
            synced: 1,
            pushed: 0,
            renamed: renamed ? 1 : 0,
            summaryText: this.plugin.t("noteSync.updated")
        });
        return true;
    }

    async forcePushRecord(didaId: string): Promise<boolean> {
        const record = await this.ensureRecord(didaId);
        if (!record) throw new Error(this.plugin.t("noteSync.recordMissing"));
        if (this.isDuplicateLocalFileError(record.error)) throw new Error(record.error || DUPLICATE_LOCAL_FILE_ERROR);

        const file = await this.resolveRecordFile(record);
        if (!file) throw new Error(this.plugin.t("noteSync.localMissing"));

        const parsed = await this.readParsedFile(file);
        const enabled = this.isTitleToFilenameEnabled();
        const note: DidaTask = {
            id: didaId,
            didaId,
            title: record.title || file.basename || "Untitled",
            content: enabled ? this.canonicalLocalBody(parsed, record) : parsed.body,
            desc: enabled ? this.canonicalLocalBody(parsed, record) : parsed.body,
            projectId: record.projectId || "",
            projectName: record.projectName,
            status: 0,
            kind: "NOTE",
            items: [],
            etag: record.etag || undefined,
            updatedAt: record.remoteModifiedTime || undefined
        };
        const localTitleChanged = !!record.localFileStem && file.basename !== record.localFileStem;
        const body = enabled ? this.canonicalLocalBody(parsed, record) : parsed.body;
        const titleOverride = enabled
            ? (localTitleChanged ? file.basename : (record.title || this.getDesiredStem(note)))
            : undefined;
        await this.pushLocalToRemote(note, body, titleOverride);
        const hash = this.hashMarkdownBody(body);
        await this.writeSyncedFile(file, note, body, hash, "synced", parsed);
        this.upsertRecord(note, file.path, hash, "synced", undefined, {
            localFileStem: file.basename,
            contentFormat: enabled ? "plain" : "heading"
        });
        await this.persistManualActionSummary({
            synced: 0,
            pushed: 1,
            summaryText: this.plugin.t("noteSync.updated")
        });
        return true;
    }

    private createEmptySummary(): DidaNoteSyncSummary {
        return {
            outcome: "skipped",
            fetched: 0,
            synced: 0,
            pushed: 0,
            conflicts: 0,
            skipped: 0,
            missing: 0,
            errors: [],
            summaryText: "",
            renamed: 0
        };
    }

    private async persistSummary(
        summary: DidaNoteSyncSummary,
        source: DidaNoteSyncRunSource,
        startedAt: string,
        silent: boolean
    ): Promise<DidaNoteSyncSummary> {
        this.plugin.settings.didaNoteSyncLastRun = {
            ...summary,
            source,
            startedAt,
            finishedAt: new Date().toISOString()
        };
        await this.plugin.saveSettings();
        this.plugin.refreshTaskView();
        if (!silent && summary.summaryText) {
            new Notice(summary.summaryText);
        }
        return summary;
    }

    private shouldSilenceSummaryNotice(summary: DidaNoteSyncSummary, options: NoteSyncOptions) {
        if (options.silent === true) return true;
        if (options.suppressNoopNotice !== true) return false;
        const hasChanges = summary.synced > 0
            || summary.pushed > 0
            || (summary.renamed || 0) > 0
            || summary.conflicts > 0
            || summary.missing > 0
            || summary.errors.length > 0;
        return !hasChanges;
    }

    private async persistManualActionSummary(partial: {
        synced: number;
        pushed: number;
        summaryText: string;
        renamed?: number;
    }) {
        const errors = this.collectRecordErrors();
        const summary: DidaNoteSyncSummary = {
            outcome: this.resolveRecordSummaryOutcome(partial.synced, partial.pushed, errors.length),
            fetched: this.plugin.settings.didaNoteSyncLastRun?.fetched || 0,
            synced: partial.synced,
            pushed: partial.pushed,
            conflicts: this.countRecordsByStatus("conflict"),
            skipped: 0,
            missing: this.countMissingRecords(),
            errors,
            summaryText: partial.summaryText,
            renamed: partial.renamed || 0
        };
        await this.persistSummary(summary, "manual", new Date().toISOString(), true);
    }

    private resolveRecordSummaryOutcome(synced: number, pushed: number, errorCount: number): DidaNoteSyncSummary["outcome"] {
        const issueCount = this.countRecordsByStatus("conflict") + this.countMissingRecords() + errorCount;
        if (issueCount > 0) {
            return synced > 0 || pushed > 0 ? "partial" : "failed";
        }
        return synced === 0 && pushed === 0 ? "skipped" : "success";
    }

    private resolveSummaryOutcome(summary: DidaNoteSyncSummary): DidaNoteSyncSummary["outcome"] {
        const hasChanges = summary.synced > 0 || summary.pushed > 0 || (summary.renamed || 0) > 0;
        if (summary.errors.length > 0) {
            return hasChanges || summary.conflicts > 0 || summary.missing > 0 ? "partial" : "failed";
        }
        if (summary.conflicts > 0 || summary.missing > 0) return "partial";
        if (summary.fetched === 0) return "skipped";
        return "success";
    }

    private formatSyncNotice(summary: DidaNoteSyncSummary): string {
        if (summary.errors.length > 0) return this.plugin.t("noteSync.summaryFailed", { count: summary.errors.length });
        if (summary.conflicts > 0) return this.plugin.t("noteSync.summaryConflicts", { count: summary.conflicts });
        const changedParts: string[] = [];
        if (summary.synced > 0) changedParts.push(this.plugin.t("noteSync.summaryPulled", { count: summary.synced }));
        if (summary.pushed > 0) changedParts.push(this.plugin.t("noteSync.summaryPushed", { count: summary.pushed }));
        if ((summary.renamed || 0) > 0) changedParts.push(this.plugin.t("noteSync.summaryRenamed", { count: summary.renamed }));
        if (summary.missing > 0) changedParts.push(this.plugin.t("noteSync.summaryMissing", { count: summary.missing }));
        if (changedParts.length > 0) return this.plugin.t("noteSync.summaryDone", { parts: changedParts.join(this.plugin.t("modal.visibility.join")) });
        if (summary.fetched === 0) return this.plugin.t("noteSync.nothingToSync");
        return this.plugin.t("noteSync.upToDate");
    }

    private normalizeErrorMessage(error: unknown, fallback: string): string {
        if (error instanceof Error && error.message) return error.message;
        if (typeof error === "string" && error.trim()) return error.trim();
        const message = (error as any)?.message;
        return typeof message === "string" && message.trim() ? message.trim() : fallback;
    }

    private isTitleToFilenameEnabled(): boolean {
        return this.plugin.settings.didaNoteSyncTitleToFilename === true;
    }

    private async syncRemoteNote(note: DidaTask): Promise<NoteSyncResult> {
        const didaId = note.didaId || note.id;
        if (!didaId) return { result: "skipped", renamed: false };

        const enabled = this.isTitleToFilenameEnabled();
        const remoteBody = this.normalizeBody(this.getNoteBody(note));
        const remoteTitle = this.getRemoteNoteTitle(note);
        const body = this.buildLocalMarkdownBody(note, remoteBody);
        const remoteHash = this.hashMarkdownBody(body);
        const record = await this.ensureRecord(didaId, note);
        if (record && this.isDuplicateLocalFileError(record.error)) {
            throw new Error(record.error || DUPLICATE_LOCAL_FILE_ERROR);
        }
        if (record && this.localDeletionTracker.list().some(candidate => candidate.id === `note:${didaId}`)) {
            return { result: "skipped", renamed: false };
        }

        let file: TFile | null = null;
        if (record?.path) {
            const existing = this.app.vault.getAbstractFileByPath(normalizePath(record.path));
            if (existing instanceof TFile) file = existing;
        }
        if (!file) {
            const hits = await this.noteLocator.find(didaId);
            if (hits.length > 0) file = hits[0].file;
        }

        if (!record) {
            const path = await this.buildNotePath(note, didaId);
            file = await this.ensureNoteFile(path, note);
            this.upsertRecord(note, file.path, remoteHash, "synced");
            return { result: "synced", renamed: false };
        }

        if (!file) {
            // The record points at a vanished file and no file with this
            // didaNoteId exists anywhere in the note folder: recreate it.
            const path = record.path || await this.buildNotePath(note, didaId);
            file = await this.ensureNoteFile(path, note);
            this.upsertRecord(note, file.path, remoteHash, "synced");
            return { result: "synced", renamed: false };
        }

        if (this.normalizeComparablePath(record.path) !== this.normalizeComparablePath(file.path)) {
            record.path = file.path;
            await this.plugin.saveSettings();
        }

        const current = await this.readParsedFile(file);
        if (enabled) {
            return await this.syncRemoteNoteWithTitleFilename(note, record, file, current, remoteTitle, body, remoteHash);
        }
        return await this.syncRemoteNoteLegacy(note, record, file, current, body, remoteHash);
    }

    private async syncRemoteNoteLegacy(
        note: DidaTask,
        record: DidaNoteSyncRecord,
        file: TFile,
        current: ParsedNoteFile,
        body: string,
        remoteHash: string
    ): Promise<NoteSyncResult> {
        const localHash = this.hashMarkdownBody(current.body);
        const remoteChanged = this.remoteChanged(record, note, remoteHash);
        const localChanged = localHash !== record.lastSyncedContentHash;

        if (localChanged && remoteChanged) {
            const decision = resolveWholeEntityConflict({
                localModifiedAt: file.stat?.mtime,
                remoteModifiedAt: (note as any).updatedAt || (note as any).modifiedTime
            });
            if (decision === "unresolvable") {
                throw new Error(this.plugin.t("noteSync.conflictTimestampsUncomparable"));
            }
            if (decision === "local") {
                await this.pushLocalToRemote(note, current.body);
                const pushedHash = this.hashMarkdownBody(current.body);
                await this.writeSyncedFile(file, note, current.body, pushedHash, "synced", current);
                this.upsertRecord(note, file.path, pushedHash, "synced");
                return { result: "pushed", renamed: false };
            }
            await this.writeSyncedFile(file, note, body, remoteHash, "synced", current);
            this.upsertRecord(note, file.path, remoteHash, "synced");
            return { result: "synced", renamed: false };
        }

        if (localChanged) {
            await this.pushLocalToRemote(note, current.body);
            const pushedHash = this.hashMarkdownBody(current.body);
            await this.writeSyncedFile(file, note, current.body, pushedHash, "synced", current);
            this.upsertRecord(note, file.path, pushedHash, "synced");
            return { result: "pushed", renamed: false };
        }

        if (remoteChanged) {
            await this.writeSyncedFile(file, note, body, remoteHash, "synced", current);
            this.upsertRecord(note, file.path, remoteHash, "synced");
            return { result: "synced", renamed: false };
        }

        this.upsertRecord(note, file.path, record.lastSyncedContentHash, "synced");
        return { result: "skipped", renamed: false };
    }

    private async syncRemoteNoteWithTitleFilename(
        note: DidaTask,
        record: DidaNoteSyncRecord,
        file: TFile,
        current: ParsedNoteFile,
        remoteTitle: string,
        remoteBodyMarkdown: string,
        remoteHash: string
    ): Promise<NoteSyncResult> {
        const didaId = note.didaId || note.id;
        if (!didaId) return { result: "skipped", renamed: false };

        const fileStem = file.basename;
        const recordStem = record.localFileStem;
        const localTitleChanged = !!recordStem && fileStem !== recordStem;
        const recordedTitle = String(record.title || "").trim();
        const remoteTitleChanged = remoteTitle !== recordedTitle;
        const remoteMetaChanged = this.remoteMetaChanged(record, note);

        if (record.contentFormat !== "plain") {
            // One-time migration from the legacy `## 标题` + `标题-<id>.md` layout.
            const localBody = stripLeadingTitleHeading(current.body, [record.title, remoteTitle, "Untitled"]);
            const localHash = this.hashMarkdownBody(localBody);
            const contentMatchesRemote = localHash === remoteHash;

            if (contentMatchesRemote) {
                if (localTitleChanged) {
                    await this.pushLocalToRemote(note, localBody, fileStem);
                    await this.writeSyncedFile(file, note, localBody, localHash, "synced", current);
                    this.upsertRecord(note, file.path, localHash, "synced", undefined, {
                        localFileStem: fileStem,
                        contentFormat: "plain"
                    });
                    return { result: "pushed", renamed: false };
                }
                await this.writeSyncedFile(file, note, remoteBodyMarkdown, remoteHash, "synced", current);
                const desired = await this.renameToDesiredPath(file, note, didaId);
                this.upsertRecord(note, desired.file.path, remoteHash, "synced", undefined, {
                    localFileStem: desired.file.basename,
                    contentFormat: "plain"
                });
                return { result: "synced", renamed: desired.renamed };
            }

            if (remoteMetaChanged || remoteTitleChanged) {
                const decision = resolveWholeEntityConflict({
                    localModifiedAt: file.stat?.mtime,
                    remoteModifiedAt: (note as any).updatedAt || (note as any).modifiedTime
                });
                if (decision === "unresolvable") {
                    throw new Error(this.plugin.t("noteSync.conflictTimestampsUncomparable"));
                }
                if (decision === "local") {
                    const pushTitle = localTitleChanged ? fileStem : remoteTitle;
                    await this.pushLocalToRemote(note, localBody, pushTitle);
                    await this.writeSyncedFile(file, note, localBody, localHash, "synced", current);
                    this.upsertRecord(note, file.path, localHash, "synced", undefined, {
                        localFileStem: fileStem,
                        contentFormat: "plain"
                    });
                    return { result: "pushed", renamed: false };
                }
                await this.writeSyncedFile(file, note, remoteBodyMarkdown, remoteHash, "synced", current);
                const desired = await this.renameToDesiredPath(file, note, didaId);
                this.upsertRecord(note, desired.file.path, remoteHash, "synced", undefined, {
                    localFileStem: desired.file.basename,
                    contentFormat: "plain"
                });
                return { result: "synced", renamed: desired.renamed };
            }

            const pushTitle = localTitleChanged ? fileStem : remoteTitle;
            await this.pushLocalToRemote(note, localBody, pushTitle);
            await this.writeSyncedFile(file, note, localBody, localHash, "synced", current);
            let resultFile = file;
            let renamed = false;
            if (!localTitleChanged) {
                const desired = await this.renameToDesiredPath(file, note, didaId);
                resultFile = desired.file;
                renamed = desired.renamed;
            }
            this.upsertRecord(note, resultFile.path, localHash, "synced", undefined, {
                localFileStem: resultFile.basename,
                contentFormat: "plain"
            });
            return { result: "pushed", renamed };
        }

        const localBody = this.normalizeBody(current.body);
        const localHash = this.hashMarkdownBody(localBody);
        const localChanged = localHash !== record.lastSyncedContentHash;
        const remoteChanged = remoteHash !== record.lastSyncedContentHash || remoteMetaChanged;

        if (!localChanged && !localTitleChanged && !remoteChanged && !remoteTitleChanged) {
            this.upsertRecord(note, file.path, record.lastSyncedContentHash, "synced");
            return { result: "skipped", renamed: false };
        }

        if ((localChanged || localTitleChanged) && (remoteChanged || remoteTitleChanged)) {
            const decision = resolveWholeEntityConflict({
                localModifiedAt: file.stat?.mtime,
                remoteModifiedAt: (note as any).updatedAt || (note as any).modifiedTime
            });
            if (decision === "unresolvable") {
                throw new Error(this.plugin.t("noteSync.conflictTimestampsUncomparable"));
            }
            if (decision === "local") {
                const pushTitle = localTitleChanged ? fileStem : remoteTitle;
                await this.pushLocalToRemote(note, localBody, pushTitle);
                await this.writeSyncedFile(file, note, localBody, localHash, "synced", current);
                this.upsertRecord(note, file.path, localHash, "synced");
                return { result: "pushed", renamed: false };
            }
            await this.writeSyncedFile(file, note, remoteBodyMarkdown, remoteHash, "synced", current);
            const desired = await this.renameToDesiredPath(file, note, didaId);
            this.upsertRecord(note, desired.file.path, remoteHash, "synced");
            return { result: "synced", renamed: desired.renamed };
        }

        if (localChanged || localTitleChanged) {
            const pushTitle = localTitleChanged ? fileStem : remoteTitle;
            await this.pushLocalToRemote(note, localBody, pushTitle);
            await this.writeSyncedFile(file, note, localBody, localHash, "synced", current);
            this.upsertRecord(note, file.path, localHash, "synced");
            return { result: "pushed", renamed: false };
        }

        await this.writeSyncedFile(file, note, remoteBodyMarkdown, remoteHash, "synced", current);
        const desired = await this.renameToDesiredPath(file, note, didaId);
        this.upsertRecord(note, desired.file.path, remoteHash, "synced");
        return { result: "synced", renamed: desired.renamed };
    }

    private async markNoteError(note: DidaTask, message: string) {
        const didaId = note.didaId || note.id;
        if (!didaId) return;

        const record = await this.ensureRecord(didaId, note);
        if (record && this.isDuplicateLocalFileError(record.error)) return;

        const path = record?.path || await this.buildNotePath(note, didaId);
        const hash = record?.lastSyncedContentHash || this.hashMarkdownBody(this.buildLocalMarkdownBody(note, this.getNoteBody(note)));
        let contentFormat = record?.contentFormat;
        if (!contentFormat) {
            const file = record ? await this.resolveRecordFile(record) : null;
            if (file) {
                const parsed = await this.readParsedFile(file);
                contentFormat = this.isTitleToFilenameEnabled() && !hasLeadingTitleHeading(parsed.body, [note.title, file.basename])
                    ? "plain"
                    : "heading";
            } else {
                contentFormat = "heading";
            }
        }
        this.upsertRecord(note, path, hash, "error", message, {
            localFileStem: record?.localFileStem || this.stemOfPath(path),
            contentFormat
        });
    }

    private getNoteBody(note: DidaTask): string {
        return String(note.content || note.desc || "").replace(/\r\n/g, "\n");
    }

    private getRemoteNoteTitle(note: DidaTask): string {
        return String(note.title || "").trim();
    }

    private getDesiredStem(note: DidaTask): string {
        return sanitizeNoteFilenameStem(this.getRemoteNoteTitle(note));
    }

    private normalizeBody(body: string): string {
        return String(body || "").replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
    }

    private buildLocalMarkdownBody(note: DidaTask, body: string): string {
        const normalizedBody = this.normalizeBody(body);
        if (this.isTitleToFilenameEnabled()) return normalizedBody;
        const title = (note.title || "Untitled").trim() || "Untitled";
        return normalizedBody ? `## ${title}\n\n${normalizedBody}` : `## ${title}`;
    }

    private canonicalLocalBody(parsed: ParsedNoteFile, record: DidaNoteSyncRecord, note?: DidaTask): string {
        if (record.contentFormat === "plain") return this.normalizeBody(parsed.body);
        return stripLeadingTitleHeading(parsed.body, [record.title, note?.title, "Untitled"]);
    }

    private hashMarkdownBody(body: string) {
        return this.hash(String(body || "").replace(/\r\n/g, "\n").trimEnd());
    }

    private extractLocalNoteContent(markdownBody: string, fallbackTitle: string = "Untitled"): { title: string; content: string } {
        const normalized = String(markdownBody || "").replace(/\r\n/g, "\n");
        const lines = normalized.split("\n");
        const headingIndex = lines.findIndex((line) => /^##(?!#)\s+/.test(line.trim()));
        if (headingIndex === -1) {
            return {
                title: (fallbackTitle || "Untitled").trim() || "Untitled",
                content: normalized.replace(/^\n+/, "").trimEnd()
            };
        }

        const title = lines[headingIndex].trim().replace(/^##(?!#)\s+/, "").trim() || fallbackTitle || "Untitled";
        const contentLines = [
            ...lines.slice(0, headingIndex),
            ...lines.slice(headingIndex + 1)
        ];
        return {
            title: title.trim() || "Untitled",
            content: contentLines.join("\n").replace(/^\n+/, "").trimEnd()
        };
    }

    private remoteChanged(record: DidaNoteSyncRecord, note: DidaTask, remoteHash: string): boolean {
        return remoteHash !== record.lastSyncedContentHash || this.remoteMetaChanged(record, note);
    }

    private remoteMetaChanged(record: DidaNoteSyncRecord, note: DidaTask): boolean {
        const remoteModified = (note as any).updatedAt || (note as any).modifiedTime || null;
        return (!!note.etag && note.etag !== record.etag) ||
            (!!remoteModified && remoteModified !== record.remoteModifiedTime);
    }

    private async pushLocalToRemote(note: DidaTask, body: string, titleOverride?: string) {
        const didaId = note.didaId || note.id;
        if (!didaId) throw new Error(this.plugin.t("noteSync.missingDidaId"));
        let title: string;
        let content: string;
        if (titleOverride !== undefined) {
            title = titleOverride;
            content = this.normalizeBody(body);
        } else {
            const localNote = this.extractLocalNoteContent(body, note.title);
            title = localNote.title;
            content = localNote.content;
        }
        note.title = title;
        const payload = {
            id: didaId,
            title,
            content,
            desc: content,
            projectId: note.projectId,
            status: note.status ?? 0,
            kind: "NOTE",
            startDate: note.startDate || undefined,
            dueDate: note.dueDate || undefined,
            isAllDay: note.isAllDay ?? true,
            timeZone: note.timeZone || this.plugin.getUserTimeZone()
        };
        const updated = await this.plugin.apiClient.updateNote(didaId, payload);
        if (updated && typeof updated === "object") {
            note.etag = updated.etag || note.etag;
            note.updatedAt = updated.modifiedTime || updated.updatedAt || new Date().toISOString();
        } else {
            note.updatedAt = new Date().toISOString();
        }
    }

    private async ensureRecord(didaId: string, note?: DidaTask): Promise<DidaNoteSyncRecord | undefined> {
        const existing = this.findRecord(didaId);
        if (existing) return existing;

        const matches = await this.findLocalFilesByDidaId(didaId);
        if (matches.length === 0) return undefined;

        if (matches.length > 1) {
            const primary = matches[0];
            const duplicateTitle = note?.title || primary.file.basename || "Untitled";
            const duplicateNote: DidaTask = {
                id: didaId,
                didaId,
                title: duplicateTitle,
                content: primary.parsed.body,
                desc: primary.parsed.body,
                projectId: note?.projectId || "",
                projectName: note?.projectName,
                status: 0,
                kind: "NOTE",
                items: []
            };
            this.upsertRecord(
                duplicateNote,
                primary.file.path,
                this.hashMarkdownBody(primary.parsed.body),
                "error",
                DUPLICATE_LOCAL_FILE_ERROR
            );
            return this.findRecord(didaId);
        }

        const adopted = this.buildRecordFromFile(matches[0].file, matches[0].parsed, note);
        this.mergeRecord(adopted);
        return adopted;
    }

    private buildRecordFromFile(file: TFile, parsed: ParsedNoteFile, note?: DidaTask): DidaNoteSyncRecord {
        const frontmatter = parsed.frontmatter || {};
        const didaId = String(frontmatter.didaNoteId || note?.didaId || note?.id || "");
        const projectInfo = note && this.plugin.resolveTaskProjectInfo
            ? this.plugin.resolveTaskProjectInfo(note)
            : { id: note?.projectId, name: note?.projectName || note?.projectId };
        const enabled = this.isTitleToFilenameEnabled();
        const candidates = [note?.title || "", file.basename, frontmatter.didaNoteTitle];
        const contentFormat: "heading" | "plain" = enabled && !hasLeadingTitleHeading(parsed.body, candidates)
            ? "plain"
            : "heading";
        return {
            didaId,
            title: note?.title || file.basename || "Untitled",
            path: file.path,
            projectId: projectInfo?.id || note?.projectId,
            projectName: projectInfo?.name || note?.projectName || note?.projectId,
            etag: this.normalizeOptionalString(frontmatter.didaEtag ?? frontmatter.didaRemoteEtag),
            remoteModifiedTime: this.normalizeOptionalString(frontmatter.didaModifiedTime ?? frontmatter.didaRemoteModifiedTime),
            lastSyncedContentHash: this.normalizeOptionalString(frontmatter.didaLastSyncedContentHash) || this.hashMarkdownBody(parsed.body),
            lastSyncedAt: this.normalizeOptionalString(frontmatter.didaLastSyncedAt) || new Date().toISOString(),
            status: this.normalizeRecordStatus(frontmatter.didaNoteSyncStatus),
            remoteMissing: false,
            error: undefined,
            localFileStem: file.basename,
            contentFormat
        };
    }

    private mergeRecord(record: DidaNoteSyncRecord) {
        const records = Array.isArray(this.plugin.settings.didaNoteSyncRecords)
            ? this.plugin.settings.didaNoteSyncRecords
            : [];
        const index = records.findIndex((item) => item.didaId === record.didaId);
        if (index === -1) records.push(record);
        else records[index] = record;
        this.plugin.settings.didaNoteSyncRecords = records;
    }

    private normalizeRecordStatus(value: unknown): DidaNoteSyncStatus {
        return typeof value === "string" && ["synced", "conflict", "error", "missing"].includes(value)
            ? value as DidaNoteSyncStatus
            : "synced";
    }

    private normalizeOptionalString(value: unknown): string | null {
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }

    private isDuplicateLocalFileError(error?: string) {
        return typeof error === "string" && error.includes(DUPLICATE_LOCAL_FILE_MARKER);
    }

    private async findLocalFilesByDidaId(didaId: string): Promise<LocalNoteMatch[]> {
        const hits = await this.noteLocator.find(didaId);
        const matches: LocalNoteMatch[] = [];
        for (const hit of hits) {
            matches.push({
                file: hit.file,
                parsed: await this.readParsedFile(hit.file)
            });
        }
        return matches;
    }

    private async resolveRecordFile(record: DidaNoteSyncRecord): Promise<TFile | null> {
        if (record.path) {
            const existing = this.app.vault.getAbstractFileByPath(normalizePath(record.path));
            if (existing instanceof TFile) return existing;
        }
        const hits = await this.noteLocator.find(record.didaId);
        return hits.length > 0 ? hits[0].file : null;
    }

    private async readParsedFile(file: TFile): Promise<ParsedNoteFile> {
        const read = typeof (this.app.vault as any).cachedRead === "function"
            ? (this.app.vault as any).cachedRead.bind(this.app.vault)
            : this.app.vault.read.bind(this.app.vault);
        return parseNoteFile(await read(file));
    }

    private async ensureNoteFile(path: string, note: DidaTask): Promise<TFile> {
        const normalized = normalizePath(path.endsWith(".md") ? path : `${path}.md`);
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts.slice(0, -1)) {
            current = current ? `${current}/${part}` : part;
            const existingFolder = this.app.vault.getAbstractFileByPath(current);
            if (existingFolder instanceof TFile) {
                throw new Error(this.plugin.t("noteSync.folderPathOccupiedByFile", { path: current }));
            }
            if (!existingFolder) {
                await this.app.vault.createFolder(current);
            }
        }
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof TFile) return existing;
        if (existing) throw new Error(this.plugin.t("noteSync.notePathOccupiedByFolder", { path: normalized }));
        const body = this.buildLocalMarkdownBody(note, this.getNoteBody(note));
        const hash = this.hashMarkdownBody(body);
        const created = await this.app.vault.create(normalized, this.renderFile(note, body, hash, "synced"));
        this.invalidatePathCache();
        this.noteLocator.invalidate();
        return created;
    }

    private async buildNotePath(note: DidaTask, didaId: string, selfPath?: string): Promise<string> {
        const root = (this.plugin.settings.didaNoteSyncFolder || "DidaNotes").trim();
        if (!this.isTitleToFilenameEnabled()) {
            const fileName = `${this.slugify(note.title || "Untitled")}-${didaId.slice(-6)}.md`;
            const basePath = normalizePath(root ? `${root}/${fileName}` : fileName);
            if (this.isPathAvailable(basePath, didaId)) return basePath;

            const stem = basePath.replace(/\.md$/i, "");
            for (let i = 2; i < 1000; i++) {
                const candidate = `${stem}-${i}.md`;
                if (this.isPathAvailable(candidate, didaId)) return candidate;
            }
            return `${stem}-${Date.now()}.md`;
        }

        const baseStem = this.getDesiredStem(note);
        for (let i = 0; i < 1000; i++) {
            const candidate = normalizePath(root
                ? `${root}/${buildConflictStem(baseStem, i)}.md`
                : `${buildConflictStem(baseStem, i)}.md`);
            if (this.isPathAvailable(candidate, didaId, selfPath)) return candidate;
        }
        return normalizePath(root
            ? `${root}/${buildConflictStem(baseStem, 1000)}-${Date.now()}.md`
            : `${buildConflictStem(baseStem, 1000)}-${Date.now()}.md`);
    }

    private isPathAvailable(path: string, didaId: string, selfPath?: string): boolean {
        const comparable = this.normalizeComparablePath(path);
        if (selfPath && comparable === this.normalizeComparablePath(selfPath)) return true;
        if (this.getLowerPathSet().has(comparable)) return false;
        return !(this.plugin.settings.didaNoteSyncRecords || []).some(
            (record) => record.didaId !== didaId && this.normalizeComparablePath(record.path) === comparable
        );
    }

    private getLowerPathSet(): Set<string> {
        if (this.lowerPathCache) return this.lowerPathCache;
        const set = new Set<string>();
        const getMarkdownFiles = (this.app.vault as any)?.getMarkdownFiles;
        if (typeof getMarkdownFiles === "function") {
            const files = getMarkdownFiles.call(this.app.vault);
            if (Array.isArray(files)) {
                files.forEach((file: any) => {
                    if (file?.path) set.add(this.normalizeComparablePath(file.path));
                });
            }
        }
        this.lowerPathCache = set;
        return set;
    }

    private invalidatePathCache() {
        this.lowerPathCache = null;
    }

    private async renameToDesiredPath(file: TFile, note: DidaTask, didaId: string): Promise<{ file: TFile; renamed: boolean }> {
        let current = file;
        for (let attempt = 0; attempt < 5; attempt++) {
            const desired = await this.buildNotePath(note, didaId, current.path);
            if (this.normalizeComparablePath(desired) === this.normalizeComparablePath(current.path)) {
                return { file: current, renamed: attempt > 0 };
            }
            try {
                return { file: await this.renameNoteFile(current, desired), renamed: true };
            } catch (_error) {
                this.invalidatePathCache();
                this.noteLocator.invalidate();
            }
        }
        return { file: current, renamed: false };
    }

    private async renameNoteFile(file: TFile, newPath: string): Promise<TFile> {
        const fileManager = (this.app as any).fileManager;
        if (!fileManager || typeof fileManager.renameFile !== "function") {
            throw new Error(this.plugin.t("noteSync.renameUnavailable"));
        }
        this.expectedRenamePaths.set(this.normalizeComparablePath(newPath), Date.now());
        try {
            await fileManager.renameFile(file, newPath);
        } catch (error) {
            this.expectedRenamePaths.delete(this.normalizeComparablePath(newPath));
            throw error;
        }
        this.invalidatePathCache();
        this.noteLocator.invalidate();
        const renamed = this.app.vault.getAbstractFileByPath(newPath);
        return renamed instanceof TFile ? renamed : file;
    }

    private pruneExpectedRenames() {
        const now = Date.now();
        for (const [key, at] of this.expectedRenamePaths) {
            if (now - at > EXPECTED_RENAME_TTL_MS) this.expectedRenamePaths.delete(key);
        }
    }

    private stemOfPath(path: string): string {
        const normalized = String(path || "").replace(/\\/g, "/");
        const name = normalized.split("/").pop() || "";
        return name.replace(/\.md$/i, "");
    }

    private normalizeComparablePath(path: string): string {
        const normalized = normalizePath(String(path || "").replace(/\\/g, "/"));
        return normalized.toLowerCase();
    }

    private async writeSyncedFile(
        file: TFile,
        note: DidaTask,
        body: string,
        hash: string,
        status: "synced" | "conflict",
        parsed?: ParsedNoteFile
    ) {
        await this.app.vault.modify(file, this.renderFile(note, body, hash, status, parsed?.frontmatterLines || []));
    }

    private renderFile(note: DidaTask, body: string, hash: string, status: "synced" | "conflict", preservedLines: string[] = []) {
        const didaId = note.didaId || note.id;
        const frontmatter = {
            didaNoteId: didaId,
            didaNoteKind: "NOTE",
            didaNoteSyncStatus: status,
            didaEtag: note.etag || "",
            didaModifiedTime: (note as any).updatedAt || "",
            didaLastSyncedContentHash: hash,
            didaLastSyncedAt: new Date().toISOString()
        };
        return renderNoteDocument(frontmatter, body, preservedLines);
    }

    private findRecord(didaId: string): DidaNoteSyncRecord | undefined {
        return (this.plugin.settings.didaNoteSyncRecords || []).find((record) => record.didaId === didaId);
    }

    private markMissingRemoteRecords(remoteNotes: DidaTask[]): number {
        const records = Array.isArray(this.plugin.settings.didaNoteSyncRecords)
            ? this.plugin.settings.didaNoteSyncRecords
            : [];
        if (records.length === 0) return 0;

        const selectedProjectIds = new Set((this.plugin.settings.didaNoteSyncProjectIds || []).filter(Boolean));
        if (selectedProjectIds.size === 0) return 0;

        const remoteIds = new Set(remoteNotes.map((note) => note.didaId || note.id).filter(Boolean));
        let missing = 0;
        records.forEach((record) => {
            if (record.projectId && !selectedProjectIds.has(record.projectId)) return;
            if (remoteIds.has(record.didaId)) return;
            if (!record.remoteMissing || record.status !== "missing") missing++;
            record.remoteMissing = true;
            record.status = "missing";
            record.error = this.plugin.t("noteSync.remoteMissing");
        });
        return missing;
    }

    private upsertRecord(
        note: DidaTask,
        path: string,
        hash: string,
        status: "synced" | "conflict" | "error",
        error?: string,
        extra?: RecordExtraFields
    ) {
        const didaId = note.didaId || note.id;
        if (!didaId) return;
        const noteWithProject = this.withSelectedNoteProjectFallback(note);

        const records = Array.isArray(this.plugin.settings.didaNoteSyncRecords)
            ? this.plugin.settings.didaNoteSyncRecords
            : [];
        const projectInfo = this.plugin.resolveTaskProjectInfo
            ? this.plugin.resolveTaskProjectInfo(noteWithProject)
            : { id: noteWithProject.projectId, name: noteWithProject.projectName || noteWithProject.projectId };
        const next: DidaNoteSyncRecord = {
            didaId,
            title: String(noteWithProject.title || ""),
            path,
            projectId: projectInfo.id || noteWithProject.projectId,
            projectName: projectInfo.name || noteWithProject.projectName || noteWithProject.projectId,
            etag: noteWithProject.etag || null,
            remoteModifiedTime: (noteWithProject as any).updatedAt || null,
            lastSyncedContentHash: hash,
            lastSyncedAt: new Date().toISOString(),
            status,
            remoteMissing: false,
            error,
            localFileStem: extra?.localFileStem || this.stemOfPath(path),
            contentFormat: extra?.contentFormat || (this.isTitleToFilenameEnabled() ? "plain" : "heading")
        };
        const index = records.findIndex((record) => record.didaId === didaId);
        if (index === -1) records.push(next);
        else records[index] = next;
        this.plugin.settings.didaNoteSyncRecords = records;
    }

    private getSingleSelectedNoteProjectFallback() {
        const ids = (this.plugin.settings.didaNoteSyncProjectIds || []).filter(Boolean);
        if (ids.length !== 1) return null;
        return this.getProjectDisplayForSync(ids[0]);
    }

    private getProjectDisplayForSync(projectId: string) {
        if (typeof this.plugin.getProjectDisplayInfo === "function") {
            const display = this.plugin.getProjectDisplayInfo(projectId);
            return {
                id: display.id || projectId,
                name: display.name || projectId,
                kind: display.kind || "NOTE",
                viewMode: display.viewMode || "note"
            };
        }
        const id = typeof this.plugin.normalizeProjectDisplayId === "function"
            ? this.plugin.normalizeProjectDisplayId(projectId)
            : projectId;
        const catalog = typeof this.plugin.getProjectCatalog === "function"
            ? this.plugin.getProjectCatalog()
            : [];
        const project = Array.isArray(catalog) ? catalog.find((entry: any) => entry?.id === id) : null;
        return {
            id,
            name: id === "inbox" ? INBOX_PROJECT_NAME : project?.name || id,
            kind: project?.kind || "NOTE",
            viewMode: project?.viewMode || "note"
        };
    }

    private withSelectedNoteProjectFallback(note: DidaTask): DidaTask {
        if (note.projectId) return note;
        const fallback = this.getSingleSelectedNoteProjectFallback();
        if (!fallback) return note;
        return {
            ...note,
            projectId: fallback.id,
            projectName: note.projectName || fallback.name,
            projectKind: note.projectKind || fallback.kind,
            projectViewMode: note.projectViewMode || fallback.viewMode
        };
    }

    private clearCachedNoteTasks(didaId?: string) {
        if (!Array.isArray(this.plugin.settings.tasks)) return 0;
        const before = this.plugin.settings.tasks.length;
        this.plugin.settings.tasks = this.plugin.settings.tasks.filter((task: DidaTask) => {
            if (!this.isCachedNoteTask(task)) return true;
            if (!didaId) return false;
            return task.didaId !== didaId && task.id !== didaId;
        });
        return before - this.plugin.settings.tasks.length;
    }

    private isCachedNoteTask(task: DidaTask | null | undefined) {
        if (!task || typeof task !== "object") return false;
        if (typeof this.plugin.isNoteListItem === "function") return this.plugin.isNoteListItem(task);
        return task.kind === "NOTE" ||
            task.projectKind === "NOTE" ||
            (typeof task.projectViewMode === "string" && task.projectViewMode.trim().toLowerCase() === "note");
    }

    private countRecordsByStatus(status: DidaNoteSyncStatus): number {
        return (this.plugin.settings.didaNoteSyncRecords || []).filter((record) => record.status === status).length;
    }

    private countMissingRecords(): number {
        return (this.plugin.settings.didaNoteSyncRecords || []).filter((record) => record.status === "missing" || record.remoteMissing).length;
    }

    private collectRecordErrors(): string[] {
        return (this.plugin.settings.didaNoteSyncRecords || [])
            .filter((record) => record.status === "error" && typeof record.error === "string" && record.error.trim())
            .map((record) => record.error!.trim());
    }

    private slugify(value: string): string {
        const sanitized = value
            .replace(/[\\/:*?"<>|#^\[\]]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
        return sanitized || "Untitled";
    }

    private hash(value: string): string {
        let hash = 2166136261;
        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }
}
