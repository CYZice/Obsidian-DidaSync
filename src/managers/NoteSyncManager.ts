import { App, normalizePath, Notice, TFile } from "obsidian";
import DidaSyncPlugin from "../main";
import { DidaNoteSyncRecord, DidaNoteSyncRunSource, DidaNoteSyncStatus, DidaNoteSyncSummary, DidaTask } from "../types";

interface ParsedNoteFile {
    frontmatter: Record<string, any>;
    body: string;
}

interface NoteSyncOptions {
    silent?: boolean;
    suppressNoopNotice?: boolean;
    source?: DidaNoteSyncRunSource;
}

interface LocalNoteMatch {
    file: TFile;
    parsed: ParsedNoteFile;
}

const DUPLICATE_LOCAL_FILE_ERROR = "检测到多个本地 Markdown 拥有相同 didaNoteId，请先手动清理重复文件。";

export class NoteSyncManager {
    app: App;
    plugin: DidaSyncPlugin;

    constructor(app: App, plugin: DidaSyncPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    async syncNow(options: NoteSyncOptions = {}): Promise<DidaNoteSyncSummary> {
        const source = options.source || "manual";
        const startedAt = new Date().toISOString();
        const summary = this.createEmptySummary();

        try {
            if (!this.plugin.settings.enableDidaNoteSync) {
                summary.outcome = "skipped";
                summary.summaryText = "笔记同步未启用";
                return await this.persistSummary(summary, source, startedAt, this.shouldSilenceSummaryNotice(summary, options));
            }
            if (!this.plugin.settings.accessToken) throw new Error("请先完成 OAuth 认证");
            if ((this.plugin.settings.didaNoteSyncProjectIds || []).filter(Boolean).length === 0) {
                summary.outcome = "skipped";
                summary.summaryText = "请先选择笔记清单";
                return await this.persistSummary(summary, source, startedAt, this.shouldSilenceSummaryNotice(summary, options));
            }

            const remoteNotes = await this.fetchRemoteNotes();
            summary.fetched = remoteNotes.length;
            summary.missing = this.markMissingRemoteRecords(remoteNotes);

            for (const note of remoteNotes) {
                try {
                    const result = await this.syncRemoteNote(note);
                    summary[result]++;
                } catch (error: any) {
                    const message = this.normalizeErrorMessage(error, "同步笔记失败");
                    summary.errors.push(message);
                    await this.markNoteError(note, message);
                }
            }

            summary.outcome = this.resolveSummaryOutcome(summary);
            summary.summaryText = this.formatSyncNotice(summary);
            return await this.persistSummary(summary, source, startedAt, this.shouldSilenceSummaryNotice(summary, options));
        } catch (error: any) {
            const message = this.normalizeErrorMessage(error, "同步笔记失败");
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
        await this.plugin.saveSettings();
        this.plugin.refreshTaskView();
        return true;
    }

    async forcePullRecord(didaId: string): Promise<boolean> {
        const record = await this.ensureRecord(didaId);
        if (!record) throw new Error("未找到本地同步记录");
        if (this.isDuplicateLocalFileError(record.error)) throw new Error(record.error || DUPLICATE_LOCAL_FILE_ERROR);

        const remoteNotes = await this.fetchRemoteNotes();
        const remote = remoteNotes.find((note) => (note.didaId || note.id) === didaId);
        if (!remote) {
            record.remoteMissing = true;
            record.status = "missing";
            record.error = "远端笔记已不存在";
            await this.persistManualActionSummary({
                synced: 0,
                pushed: 0,
                summaryText: "远端笔记已不存在"
            });
            return false;
        }

        const body = this.buildLocalMarkdownBody(remote, this.getNoteBody(remote));
        const hash = this.hashMarkdownBody(body);
        const path = record.path || await this.buildUniqueNotePath(remote, didaId);
        const file = await this.ensureNoteFile(path, remote);
        await this.writeSyncedFile(file, remote, body, hash, "synced");
        this.upsertRecord(remote, file.path, hash, "synced");
        await this.persistManualActionSummary({
            synced: 1,
            pushed: 0,
            summaryText: "笔记已更新"
        });
        return true;
    }

    async forcePushRecord(didaId: string): Promise<boolean> {
        const record = await this.ensureRecord(didaId);
        if (!record) throw new Error("未找到本地同步记录");
        if (this.isDuplicateLocalFileError(record.error)) throw new Error(record.error || DUPLICATE_LOCAL_FILE_ERROR);

        const file = this.app.vault.getAbstractFileByPath(record.path);
        if (!(file instanceof TFile)) throw new Error("本地 Markdown 文件不存在");

        const parsed = await this.readParsedFile(file);
        const body = parsed.body;
        const note: DidaTask = {
            id: didaId,
            didaId,
            title: record.title || file.basename || "Untitled",
            content: body,
            desc: body,
            projectId: record.projectId || "",
            projectName: record.projectName,
            status: 0,
            kind: "NOTE",
            items: [],
            etag: record.etag || undefined,
            updatedAt: record.remoteModifiedTime || undefined
        };
        await this.pushLocalToRemote(note, body);
        const hash = this.hashMarkdownBody(body);
        await this.writeSyncedFile(file, note, body, hash, "synced");
        this.upsertRecord(note, file.path, hash, "synced");
        await this.persistManualActionSummary({
            synced: 0,
            pushed: 1,
            summaryText: "笔记已更新"
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
            summaryText: ""
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
        const hasChanges = summary.synced > 0 || summary.pushed > 0 || summary.conflicts > 0 || summary.missing > 0 || summary.errors.length > 0;
        return !hasChanges;
    }

    private async persistManualActionSummary(partial: {
        synced: number;
        pushed: number;
        summaryText: string;
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
            summaryText: partial.summaryText
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
        const hasChanges = summary.synced > 0 || summary.pushed > 0;
        if (summary.errors.length > 0) {
            return hasChanges || summary.conflicts > 0 || summary.missing > 0 ? "partial" : "failed";
        }
        if (summary.conflicts > 0 || summary.missing > 0) return "partial";
        if (summary.fetched === 0) return "skipped";
        return "success";
    }

    private formatSyncNotice(summary: DidaNoteSyncSummary): string {
        if (summary.errors.length > 0) return `笔记同步完成，失败 ${summary.errors.length} 条`;
        if (summary.conflicts > 0) return `笔记同步完成，${summary.conflicts} 条需合并`;
        const changedParts: string[] = [];
        if (summary.synced > 0) changedParts.push(`拉取 ${summary.synced}`);
        if (summary.pushed > 0) changedParts.push(`推送 ${summary.pushed}`);
        if (summary.missing > 0) changedParts.push(`缺失 ${summary.missing}`);
        if (changedParts.length > 0) return `笔记同步完成：${changedParts.join("，")}`;
        if (summary.fetched === 0) return "没有可同步的笔记";
        return "笔记已是最新";
    }

    private normalizeErrorMessage(error: unknown, fallback: string): string {
        if (error instanceof Error && error.message) return error.message;
        if (typeof error === "string" && error.trim()) return error.trim();
        const message = (error as any)?.message;
        return typeof message === "string" && message.trim() ? message.trim() : fallback;
    }

    private async syncRemoteNote(note: DidaTask): Promise<"synced" | "pushed" | "conflicts" | "skipped"> {
        const didaId = note.didaId || note.id;
        if (!didaId) return "skipped";

        const body = this.buildLocalMarkdownBody(note, this.getNoteBody(note));
        const remoteHash = this.hashMarkdownBody(body);
        const record = await this.ensureRecord(didaId, note);
        if (record && this.isDuplicateLocalFileError(record.error)) {
            throw new Error(record.error || DUPLICATE_LOCAL_FILE_ERROR);
        }

        const path = record?.path || await this.buildUniqueNotePath(note, didaId);
        const file = await this.ensureNoteFile(path, note);

        if (!record) {
            await this.writeSyncedFile(file, note, body, remoteHash, "synced");
            this.upsertRecord(note, file.path, remoteHash, "synced");
            return "synced";
        }

        const current = await this.readParsedFile(file);
        const localHash = this.hashMarkdownBody(current.body);
        const remoteChanged = this.remoteChanged(record, note, remoteHash);
        const localChanged = localHash !== record.lastSyncedContentHash;

        if (localChanged && remoteChanged) {
            await this.markConflict(file, current, note, record);
            this.upsertRecord(note, file.path, record.lastSyncedContentHash, "conflict", "本地和云端同时修改，请手动合并后重新同步。");
            return "conflicts";
        }

        if (localChanged) {
            await this.pushLocalToRemote(note, current.body);
            const pushedHash = this.hashMarkdownBody(current.body);
            await this.writeSyncedFile(file, note, current.body, pushedHash, "synced");
            this.upsertRecord(note, file.path, pushedHash, "synced");
            return "pushed";
        }

        if (remoteChanged) {
            await this.writeSyncedFile(file, note, body, remoteHash, "synced");
            this.upsertRecord(note, file.path, remoteHash, "synced");
            return "synced";
        }

        this.upsertRecord(
            note,
            file.path,
            record.lastSyncedContentHash,
            "synced"
        );
        return "skipped";
    }

    private async markNoteError(note: DidaTask, message: string) {
        const didaId = note.didaId || note.id;
        if (!didaId) return;

        const record = await this.ensureRecord(didaId, note);
        if (record && this.isDuplicateLocalFileError(record.error)) return;

        const path = record?.path || await this.buildUniqueNotePath(note, didaId);
        const hash = record?.lastSyncedContentHash || this.hashMarkdownBody(this.buildLocalMarkdownBody(note, this.getNoteBody(note)));
        this.upsertRecord(note, path, hash, "error", message);
    }

    private getNoteBody(note: DidaTask): string {
        return String(note.content || note.desc || "").replace(/\r\n/g, "\n");
    }

    private buildLocalMarkdownBody(note: DidaTask, body: string): string {
        const title = (note.title || "Untitled").trim() || "Untitled";
        const normalizedBody = String(body || "").replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
        return normalizedBody ? `## ${title}\n\n${normalizedBody}` : `## ${title}`;
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
        const remoteModified = (note as any).updatedAt || (note as any).modifiedTime || null;
        if (record.status === "conflict") {
            return (!!note.etag && note.etag !== record.etag) ||
                (!!remoteModified && remoteModified !== record.remoteModifiedTime);
        }
        return remoteHash !== record.lastSyncedContentHash ||
            (!!note.etag && note.etag !== record.etag) ||
            (!!remoteModified && remoteModified !== record.remoteModifiedTime);
    }

    private async pushLocalToRemote(note: DidaTask, body: string) {
        const didaId = note.didaId || note.id;
        if (!didaId) throw new Error("缺少滴答笔记 id，无法回写");
        const localNote = this.extractLocalNoteContent(body, note.title);
        note.title = localNote.title;
        const payload = {
            id: didaId,
            title: localNote.title,
            content: localNote.content,
            desc: localNote.content,
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
            error: undefined
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
        return typeof error === "string" && error.includes("多个本地 Markdown");
    }

    private async findLocalFilesByDidaId(didaId: string): Promise<LocalNoteMatch[]> {
        const matches: LocalNoteMatch[] = [];
        for (const file of this.getNoteSyncMarkdownFiles()) {
            const frontmatter = await this.getFileFrontmatter(file);
            if (String(frontmatter.didaNoteId || "") !== didaId) continue;
            matches.push({
                file,
                parsed: await this.readParsedFile(file)
            });
        }
        return matches;
    }

    private getNoteSyncMarkdownFiles(): TFile[] {
        const getMarkdownFiles = (this.app.vault as any)?.getMarkdownFiles;
        if (typeof getMarkdownFiles !== "function") return [];
        const files = getMarkdownFiles.call(this.app.vault);
        if (!Array.isArray(files)) return [];

        const root = normalizePath((this.plugin.settings.didaNoteSyncFolder || "").trim());
        if (!root) {
            return files.filter((file) => file instanceof TFile && !file.path.includes("/"));
        }

        const prefix = `${root}/`;
        return files.filter((file) => file instanceof TFile && file.path.startsWith(prefix));
    }

    private async getFileFrontmatter(file: TFile): Promise<Record<string, any>> {
        const cache = (this.app.metadataCache as any)?.getFileCache?.(file);
        if (cache?.frontmatter && typeof cache.frontmatter === "object") {
            return cache.frontmatter as Record<string, any>;
        }
        return (await this.readParsedFile(file)).frontmatter;
    }

    private async readParsedFile(file: TFile): Promise<ParsedNoteFile> {
        const read = typeof (this.app.vault as any).cachedRead === "function"
            ? (this.app.vault as any).cachedRead.bind(this.app.vault)
            : this.app.vault.read.bind(this.app.vault);
        return this.parseNoteFile(await read(file));
    }

    private async ensureNoteFile(path: string, note: DidaTask): Promise<TFile> {
        const normalized = normalizePath(path.endsWith(".md") ? path : `${path}.md`);
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts.slice(0, -1)) {
            current = current ? `${current}/${part}` : part;
            const existingFolder = this.app.vault.getAbstractFileByPath(current);
            if (existingFolder instanceof TFile) {
                throw new Error(`笔记目录路径被文件占用：${current}`);
            }
            if (!existingFolder) {
                await this.app.vault.createFolder(current);
            }
        }
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof TFile) return existing;
        if (existing) throw new Error(`笔记路径已被目录占用：${normalized}`);
        const body = this.getNoteBody(note);
        return await this.app.vault.create(normalized, this.renderFile(note, body, this.hashMarkdownBody(body), "synced"));
    }

    private async buildUniqueNotePath(note: DidaTask, didaId: string): Promise<string> {
        const root = (this.plugin.settings.didaNoteSyncFolder || "DidaNotes").trim();
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

    private isPathAvailable(path: string, didaId: string): boolean {
        if (this.app.vault.getAbstractFileByPath(path)) return false;
        return !(this.plugin.settings.didaNoteSyncRecords || []).some((record) => record.didaId !== didaId && record.path === path);
    }

    private async writeSyncedFile(file: TFile, note: DidaTask, body: string, hash: string, status: "synced" | "conflict") {
        await this.app.vault.modify(file, this.renderFile(note, body, hash, status));
    }

    private async markConflict(file: TFile, parsed: ParsedNoteFile, note: DidaTask, record: DidaNoteSyncRecord) {
        const frontmatter = {
            ...parsed.frontmatter,
            didaNoteId: note.didaId || note.id,
            didaNoteKind: "NOTE",
            didaNoteSyncStatus: "conflict",
            didaNoteConflictAt: new Date().toISOString(),
            didaEtag: note.etag || "",
            didaModifiedTime: (note as any).updatedAt || "",
            didaLastSyncedContentHash: record.lastSyncedContentHash,
            didaLastSyncedAt: new Date().toISOString()
        };
        const body = [
            "> [!warning] 滴答笔记同步冲突",
            "> 本地 Markdown 和滴答云端 NOTE 都发生了修改。请手动合并后删除本提示，并重新执行滴答笔记同步。",
            "",
            parsed.body
        ].join("\n");
        await this.app.vault.modify(file, this.stringifyMarkdown(frontmatter, body));
    }

    private renderFile(note: DidaTask, body: string, hash: string, status: "synced" | "conflict") {
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
        return this.stringifyMarkdown(frontmatter, body);
    }

    private stringifyMarkdown(frontmatter: Record<string, any>, body: string) {
        const lines = ["---"];
        Object.entries(frontmatter).forEach(([key, value]) => {
            lines.push(`${key}: ${this.formatFrontmatterValue(value)}`);
        });
        lines.push("---");
        const normalizedBody = body.replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
        if (!normalizedBody) {
            return `${lines.join("\n")}\n`;
        }
        lines.push(normalizedBody, "");
        return lines.join("\n");
    }

    private formatFrontmatterValue(value: unknown): string {
        if (value === null || value === undefined) return "null";
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
        if (typeof value === "boolean") return value ? "true" : "false";
        const normalized = String(value).replace(/\r\n/g, "\n");
        return `'${normalized.replace(/'/g, "''")}'`;
    }

    private parseNoteFile(content: string): ParsedNoteFile {
        const normalized = content.replace(/\r\n/g, "\n");
        if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
        const marker = "\n---\n";
        const end = normalized.indexOf(marker, 4);
        if (end === -1) return { frontmatter: {}, body: normalized };
        const rawFrontmatter = normalized.slice(4, end).split("\n");
        const frontmatter: Record<string, any> = {};
        rawFrontmatter.forEach((line) => {
            const idx = line.indexOf(":");
            if (idx === -1) return;
            const key = line.slice(0, idx).trim();
            const raw = line.slice(idx + 1).trim();
            frontmatter[key] = this.parseFrontmatterValue(raw);
        });
        return {
            frontmatter,
            body: normalized.slice(end + marker.length).replace(/^\n/, "")
        };
    }

    private parseFrontmatterValue(raw: string): any {
        if (!raw) return "";

        if (
            raw.startsWith("\"") ||
            raw.startsWith("{") ||
            raw.startsWith("[") ||
            raw === "null" ||
            raw === "true" ||
            raw === "false" ||
            /^-?\d+(\.\d+)?$/.test(raw)
        ) {
            try {
                return JSON.parse(raw);
            } catch (_error) {
            }
        }

        if (raw.startsWith("'") && raw.endsWith("'")) {
            return raw.slice(1, -1).replace(/''/g, "'");
        }

        if (raw === "null") return null;
        if (raw === "true") return true;
        if (raw === "false") return false;
        if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
        return raw;
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
            record.error = "远端笔记已不存在";
        });
        return missing;
    }

    private upsertRecord(note: DidaTask, path: string, hash: string, status: "synced" | "conflict" | "error", error?: string) {
        const didaId = note.didaId || note.id;
        if (!didaId) return;
        const noteWithProject = this.withSelectedNoteProjectFallback(note);
        this.upsertCachedNoteTask(noteWithProject, didaId);

        const records = Array.isArray(this.plugin.settings.didaNoteSyncRecords)
            ? this.plugin.settings.didaNoteSyncRecords
            : [];
        const projectInfo = this.plugin.resolveTaskProjectInfo
            ? this.plugin.resolveTaskProjectInfo(noteWithProject)
            : { id: noteWithProject.projectId, name: noteWithProject.projectName || noteWithProject.projectId };
        const next: DidaNoteSyncRecord = {
            didaId,
            title: noteWithProject.title || "Untitled",
            path,
            projectId: projectInfo.id || noteWithProject.projectId,
            projectName: projectInfo.name || noteWithProject.projectName || noteWithProject.projectId,
            etag: noteWithProject.etag || null,
            remoteModifiedTime: (noteWithProject as any).updatedAt || null,
            lastSyncedContentHash: hash,
            lastSyncedAt: new Date().toISOString(),
            status,
            remoteMissing: false,
            error
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
            name: id === "inbox" ? "收集箱" : project?.name || id,
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

    private upsertCachedNoteTask(note: DidaTask, didaId: string) {
        if (!Array.isArray(this.plugin.settings.tasks)) this.plugin.settings.tasks = [];
        const noteWithProject = this.withSelectedNoteProjectFallback(note);
        const normalized = this.plugin.normalizeRemoteTask
            ? this.plugin.normalizeRemoteTask({ ...noteWithProject, id: didaId, kind: "NOTE" })
            : { ...noteWithProject, id: didaId, didaId, kind: "NOTE" };
        const index = this.plugin.settings.tasks.findIndex((task: DidaTask) => task.didaId === didaId || task.id === didaId);
        if (index === -1) {
            this.plugin.settings.tasks.push(normalized);
            return;
        }
        this.plugin.settings.tasks[index] = {
            ...this.plugin.settings.tasks[index],
            ...normalized,
            id: this.plugin.settings.tasks[index].id || normalized.id,
            didaId,
            kind: "NOTE"
        };
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
