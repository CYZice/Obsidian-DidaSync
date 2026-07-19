import { App, normalizePath, Notice, TFile } from "obsidian";
import DidaSyncPlugin from "../main";
import {
    DidaSyncBlockConfig,
    insertDidaSyncBlock,
    parseDidaSyncBlocks,
    quoteCalloutLine,
    replaceDidaSyncBlockContent,
    replaceDidaSyncBlockDeclaration
} from "../taskNoteBlock";
import { formatTaskLineFromTask, parseTaskLine } from "../taskLineFormat";
import {
    resolveTaskNoteContextFromFrontmatter,
    resolveTaskNoteContextFromLegacyDate,
    resolveTaskNoteContextFromLegacyFileName,
    resolveTaskNoteContextFromTitle,
    TaskNoteResolvedContext
} from "../taskNoteContext";
import {
    buildDefaultTaskNoteFileName,
    buildTaskNoteRelativePath,
    buildTaskNoteTargetFilePath,
    ensureMarkdownExtension,
    formatDateOnly,
    getTaskNotePathPattern,
    getTaskNoteWeekRange,
    getTaskNoteWeekStem,
    getTaskNoteWeekInfo,
    parseDateOnly,
    renderTaskNotePathPattern
} from "../taskNotePath";
import { DidaTask } from "../types";

export type TaskNoteSyncRangeType = "day" | "week" | "month" | "year" | "custom";

export interface TaskNoteSyncRange {
    type: TaskNoteSyncRangeType;
    startDate: string;
    endDate: string;
}

export interface TaskNoteSyncOptions {
    range: TaskNoteSyncRange;
    createNewFile?: boolean;
    projectScope?: "all" | "visible" | "custom";
    projectKeys?: string[];
}

export interface TaskNoteSyncResolvedContext {
    rangeType: TaskNoteSyncRangeType;
    baseDate: string;
    startDate: string;
    endDate: string;
}

export interface TaskNoteDidaBlockSummaryItem {
    blockIndex: number;
    lineIndex: number;
    title: string;
    header: string;
    isCallout: boolean;
    config: DidaSyncBlockConfig;
    rangeText: string;
    projectsText: string;
    error?: string;
}

export interface TaskNoteDidaBlockAnalysis {
    file: TFile;
    totalBlocks: number;
    validBlocks: number;
    invalidBlocks: number;
    items: TaskNoteDidaBlockSummaryItem[];
}

export interface SaveDidaBlockConfigOptions {
    blockIndex?: number;
    header: string;
    config: DidaSyncBlockConfig;
}

interface ParsedTaskBlock {
    hasHeader: boolean;
    headerLineIndex: number;
    insertLineIndex: number;
    existingTaskIds: Set<string>;
    existingTaskTitles: Set<string>;
    dateGroups: Map<string, { headerLineIndex: number; insertLineIndex: number }>;
    hasExistingContent: boolean;
}

export class TaskNoteSyncManager {
    app: App;
    plugin: DidaSyncPlugin;

    constructor(app: App, plugin: DidaSyncPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    async syncTasksToNote(options: TaskNoteSyncOptions) {
        try {
            const file = await this.resolveTargetFile(options);
            const targetHeader = this.plugin.settings.taskNoteSyncTargetBlockHeader;
            const isCallout = targetHeader.trim().startsWith(">");
            const tasks = await this.getTasksForRange(options.range, options.projectKeys || [], options.projectScope || "all");
            await this.smartAppendTasksToHeader(file, targetHeader, tasks, options.range, isCallout);
            await this.app.workspace.getLeaf(false).openFile(file);
        } catch (e) {
            console.error(e);
            new Notice(`同步失败: ${e instanceof Error ? e.message : "未知错误"}`);
        }
    }

    async syncDidaBlocksInFile(file: TFile) {
        if (!(file instanceof TFile) || file.extension !== "md") {
            new Notice("请选择一个 Markdown 文件");
            return;
        }

        try {
            const content = await this.app.vault.read(file);
            const endsWithNewline = content.endsWith("\n");
            let lines = content.split("\n");
            if (endsWithNewline) lines = lines.slice(0, -1);

            const blocks = parseDidaSyncBlocks(lines, this.plugin.settings.taskNoteSyncTargetBlockHeader);
            if (blocks.length === 0) {
                new Notice("当前文件未找到 didasync 块");
                return;
            }

            const replacements: Array<{ lineIndex: number; lines: string[] }> = [];
            let syncedCount = 0;
            let skippedCount = 0;

            for (const block of blocks) {
                if (block.error) {
                    skippedCount++;
                    continue;
                }

                const projectScope = block.projectKeys.length > 0 ? "custom" : "all";
                const tasks = await this.getTasksForRange(block.range, block.projectKeys, projectScope);
                replacements.push({
                    lineIndex: block.lineIndex,
                    lines: this.formatDidaBlockTasks(tasks, block.range, block.isCallout)
                });
                syncedCount++;
            }

            if (replacements.length === 0) {
                new Notice("未同步 didasync 块，请检查配置格式");
                return;
            }

            let nextLines = lines;
            const blocksByLine = new Map(blocks.map((block) => [block.lineIndex, block]));
            for (const replacement of replacements.sort((a, b) => b.lineIndex - a.lineIndex)) {
                const block = blocksByLine.get(replacement.lineIndex);
                if (!block) continue;
                nextLines = replaceDidaSyncBlockContent(nextLines, block, replacement.lines);
            }

            await this.app.vault.modify(file, nextLines.join("\n") + (endsWithNewline ? "\n" : ""));
            const skippedText = skippedCount > 0 ? `，跳过 ${skippedCount} 个配置错误的块` : "";
            new Notice(`已同步 ${syncedCount} 个 didasync 块${skippedText}`);
        } catch (e) {
            console.error(e);
            new Notice(`同步 didasync 块失败: ${e instanceof Error ? e.message : "未知错误"}`);
        }
    }

    async analyzeDidaBlocksInFile(file: TFile | null): Promise<TaskNoteDidaBlockAnalysis | null> {
        if (!(file instanceof TFile) || file.extension !== "md") return null;

        const content = await this.app.vault.read(file);
        const lines = content.endsWith("\n")
            ? content.slice(0, -1).split("\n")
            : content.split("\n");
        const blocks = parseDidaSyncBlocks(lines, this.plugin.settings.taskNoteSyncTargetBlockHeader);
        const items = blocks.map((block, blockIndex) => ({
            blockIndex,
            lineIndex: block.lineIndex,
            title: lines[block.lineIndex]?.trim() || "",
            header: this.extractDidaBlockHeader(lines[block.lineIndex] || ""),
            isCallout: block.isCallout,
            config: { ...block.config },
            rangeText: this.formatDidaBlockRange(block.range),
            projectsText: block.config.projects.length > 0 ? block.config.projects.join(", ") : "全部清单",
            error: block.error
        }));

        return {
            file,
            totalBlocks: blocks.length,
            validBlocks: items.filter((item) => !item.error).length,
            invalidBlocks: items.filter((item) => !!item.error).length,
            items
        };
    }

    async saveDidaBlockConfigInFile(file: TFile, options: SaveDidaBlockConfigOptions): Promise<TaskNoteDidaBlockAnalysis | null> {
        if (!(file instanceof TFile) || file.extension !== "md") return null;

        const content = await this.app.vault.read(file);
        const endsWithNewline = content.endsWith("\n");
        let lines = content.length > 0 ? content.split("\n") : [];
        if (endsWithNewline) lines = lines.slice(0, -1);

        const blocks = parseDidaSyncBlocks(lines, this.plugin.settings.taskNoteSyncTargetBlockHeader);
        const header = (options.header || this.plugin.settings.taskNoteSyncTargetBlockHeader || "> [!didasync]").trim();

        if (typeof options.blockIndex === "number" && options.blockIndex >= 0 && options.blockIndex < blocks.length) {
            lines = replaceDidaSyncBlockDeclaration(lines, blocks[options.blockIndex], header, options.config);
        } else {
            lines = insertDidaSyncBlock(lines, lines.length, {
                header,
                config: options.config
            });
        }

        await this.app.vault.modify(file, lines.join("\n") + (endsWithNewline ? "\n" : ""));
        return await this.analyzeDidaBlocksInFile(file);
    }

    async resolveTargetFile(options: TaskNoteSyncOptions): Promise<TFile> {
        const path = options.createNewFile
            ? await this.buildUniqueTargetFilePath(options.range)
            : this.buildTargetFilePath(options.range);
        return await this.ensureMarkdownFile(path, this.buildInitialContent(options.range));
    }

    async getTasksForRange(range: TaskNoteSyncRange, projectKeys: string[] = [], projectScope: "all" | "visible" | "custom" = "all"): Promise<DidaTask[]> {
        const shouldFilterProjects = projectScope !== "all";
        const normalizedProjectKeys = Array.isArray(projectKeys) ? projectKeys.filter(Boolean) : [];
        if (shouldFilterProjects && normalizedProjectKeys.length === 0) return [];

        if (this.plugin.settings.taskNoteSyncUseRemoteQuery && this.plugin.settings.accessToken) {
            try {
                const start = this.parseDateOnly(range.startDate);
                start.setHours(0, 0, 0, 0);
                const end = this.parseDateOnly(range.endDate);
                end.setHours(23, 59, 59, 999);
                const projectIds = shouldFilterProjects
                    ? normalizedProjectKeys
                        .filter((key) => key.startsWith("id:"))
                        .map((key) => key.substring(3))
                        .filter(Boolean)
                    : [];
                const remoteTasks = await this.plugin.apiClient.filterTasks({
                    projectIds,
                    startDate: this.plugin.formatDidaDateTime(start),
                    endDate: this.plugin.formatDidaDateTime(end),
                    status: [0, 2]
                });
                const normalized = Array.isArray(remoteTasks)
                    ? remoteTasks.map((task) => this.plugin.normalizeRemoteTask(task))
                    : [];
                const remoteIds = new Set(normalized.flatMap((task) => [task.id, task.didaId].filter(Boolean)));
                const localPending = (this.plugin.settings.tasks || [])
                    .filter((task) => task.status !== 2 && !remoteIds.has(task.id) && !remoteIds.has(task.didaId));
                return this.selectTasksForRange([...normalized, ...localPending], range, normalizedProjectKeys, shouldFilterProjects);
            } catch (e) {
                console.error(e);
                new Notice("主动查询任务失败，已改用本地缓存任务");
            }
        }
        return this.selectTasksForRange(this.plugin.settings.tasks || [], range, normalizedProjectKeys, shouldFilterProjects);
    }

    buildInitialContent(range: TaskNoteSyncRange): string {
        return [
            "---",
            `didaSyncRangeType: ${range.type}`,
            `didaSyncStartDate: ${range.startDate}`,
            `didaSyncEndDate: ${range.endDate}`,
            "---",
            `# ${this.getRangeTitle(range)}`,
            "",
            this.plugin.settings.taskNoteSyncTargetBlockHeader,
            ""
        ].join("\n");
    }

    buildTargetFilePath(range: TaskNoteSyncRange): string {
        return buildTaskNoteTargetFilePath(range, {
            rootFolder: this.plugin.settings.taskNoteSyncFolder || "DidaSync",
            weekStart: this.plugin.settings.taskNoteSyncWeekStart || "monday",
            pathPatterns: this.plugin.settings.taskNoteSyncPathPatterns
        });
    }

    buildRelativeTargetPath(range: TaskNoteSyncRange): string {
        return buildTaskNoteRelativePath(range, {
            weekStart: this.plugin.settings.taskNoteSyncWeekStart || "monday",
            pathPatterns: this.plugin.settings.taskNoteSyncPathPatterns
        });
    }

    async buildUniqueTargetFilePath(range: TaskNoteSyncRange): Promise<string> {
        const basePath = this.buildTargetFilePath(range);
        const normalizedPath = normalizePath(basePath.endsWith(".md") ? basePath : `${basePath}.md`);
        if (!this.app.vault.getAbstractFileByPath(normalizedPath)) return normalizedPath;

        const stem = normalizedPath.slice(0, -3);
        for (let i = 2; i < 1000; i++) {
            const candidate = `${stem}-${i}.md`;
            if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
        }
        return `${stem}-${Date.now()}.md`;
    }

    buildTargetFileName(range: TaskNoteSyncRange): string {
        return buildDefaultTaskNoteFileName(range, this.plugin.settings.taskNoteSyncWeekStart || "monday");
    }

    getPathPatternForRange(range: TaskNoteSyncRange): string {
        return getTaskNotePathPattern(range.type, this.plugin.settings.taskNoteSyncPathPatterns);
    }

    renderPathPattern(range: TaskNoteSyncRange, pattern: string): string {
        return renderTaskNotePathPattern(range, pattern, this.plugin.settings.taskNoteSyncWeekStart || "monday");
    }

    ensureMarkdownExtension(path: string): string {
        return ensureMarkdownExtension(path);
    }

    async ensureMarkdownFile(path: string, initialContent: string): Promise<TFile> {
        const normalizedPath = normalizePath(path.endsWith(".md") ? path : `${path}.md`);
        const pathParts = normalizedPath.split("/").filter(Boolean);
        const folderParts = pathParts.slice(0, -1);
        let currentPath = "";
        for (const part of folderParts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folderPath = normalizePath(currentPath);
            if (!this.app.vault.getAbstractFileByPath(folderPath)) {
                await this.app.vault.createFolder(folderPath);
            }
        }

        const existingFile = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (existingFile instanceof TFile) return existingFile;
        return await this.app.vault.create(normalizedPath, initialContent);
    }

    async smartAppendTasksToHeader(file: TFile, targetHeader: string, fetchedTasks: DidaTask[], range: TaskNoteSyncRange, isCallout: boolean) {
        await this.app.vault.process(file, (data) => {
            const lines = data.split("\n");
            let parsed = this.parseExistingTaskBlock(lines, targetHeader);

            if (!parsed.hasHeader) {
                if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
                lines.push(targetHeader);
                parsed = this.parseExistingTaskBlock(lines, targetHeader);
            }

            const tasksToAppend = this.filterNewTasks(fetchedTasks, parsed);
            const taskPrefix = isCallout ? "> - " : "- ";

            if (tasksToAppend.length === 0) {
                if (fetchedTasks.length === 0 && !parsed.hasExistingContent) {
                    lines.splice(parsed.insertLineIndex, 0, `${taskPrefix}无待办任务`);
                    new Notice("所选时间段无待办任务");
                    return lines.join("\n");
                }
                new Notice("没有新任务需要同步");
                return lines.join("\n");
            }

            if (range.startDate === range.endDate) {
                const newLines = this.formatTasks(tasksToAppend, range.startDate, taskPrefix);
                lines.splice(parsed.insertLineIndex, 0, ...newLines);
            } else {
                this.insertGroupedTasks(lines, parsed, tasksToAppend, taskPrefix, isCallout);
            }
            new Notice(`成功同步 ${tasksToAppend.length} 个新任务`);
            return lines.join("\n");
        });
    }

    filterNewTasks(fetchedTasks: DidaTask[], parsed: ParsedTaskBlock): DidaTask[] {
        const tasksToAppend: DidaTask[] = [];
        for (const task of fetchedTasks) {
            const didaId = task.didaId || task.id;
            const title = this.normalizeTitle(task.title);
            if (didaId && parsed.existingTaskIds.has(didaId)) continue;
            if (parsed.existingTaskTitles.has(title)) continue;
            tasksToAppend.push(task);
        }
        return tasksToAppend;
    }

    parseExistingTaskBlock(lines: string[], headerPattern: string): ParsedTaskBlock {
        const headerIndex = lines.findIndex(line => line.trim().startsWith(headerPattern.trim()));
        if (headerIndex === -1) {
            return {
                hasHeader: false,
                headerLineIndex: -1,
                insertLineIndex: -1,
                existingTaskIds: new Set(),
                existingTaskTitles: new Set(),
                dateGroups: new Map(),
                hasExistingContent: false
            };
        }

        const existingTaskIds = new Set<string>();
        const existingTaskTitles = new Set<string>();
        const dateGroups = new Map<string, { headerLineIndex: number; insertLineIndex: number }>();
        let insertLineIndex = headerIndex + 1;
        let hasExistingContent = false;
        let currentDateGroup: string | null = null;
        let currentDateGroupHasTasks = false;

        for (let i = headerIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (this.isBlockBoundary(trimmed, headerPattern)) break;

            const dateGroup = this.extractDateGroup(trimmed);
            if (dateGroup) {
                currentDateGroup = dateGroup;
                currentDateGroupHasTasks = false;
                dateGroups.set(dateGroup, { headerLineIndex: i, insertLineIndex: i + 1 });
                hasExistingContent = true;
            } else if (this.isTaskLine(trimmed)) {
                const id = this.extractDidaId(trimmed);
                if (id) existingTaskIds.add(id);
                const title = this.extractTaskTitle(trimmed);
                if (title) existingTaskTitles.add(title);
                hasExistingContent = true;
                insertLineIndex = i + 1;
                if (currentDateGroup) {
                    currentDateGroupHasTasks = true;
                    const group = dateGroups.get(currentDateGroup);
                    if (group) group.insertLineIndex = i + 1;
                }
            } else if (trimmed !== "") {
                hasExistingContent = true;
                if (currentDateGroup && !currentDateGroupHasTasks) {
                    const group = dateGroups.get(currentDateGroup);
                    if (group) group.insertLineIndex = i;
                }
            }
        }

        return {
            hasHeader: true,
            headerLineIndex: headerIndex,
            insertLineIndex,
            existingTaskIds,
            existingTaskTitles,
            dateGroups,
            hasExistingContent
        };
    }

    isTaskLine(line: string): boolean {
        return !!parseTaskLine(line) || /^(\s*>\s*)*\s*[-*]\s\[.\]/.test(line);
    }

    isBlockBoundary(trimmedLine: string, headerPattern: string): boolean {
        if (trimmedLine.startsWith("> ### ")) return false;
        if (/^#{3,}\s+\d{4}-\d{2}-\d{2}/.test(trimmedLine)) return false;
        if (headerPattern.trim().startsWith(">")) return !trimmedLine.startsWith(">");
        return trimmedLine.startsWith("#");
    }

    extractDateGroup(line: string): string | null {
        const match = line.match(/^(?:>\s*)?#{3,}\s+(\d{4}-\d{2}-\d{2})(?:\s|$)/);
        return match ? match[1] : null;
    }

    extractDidaId(line: string): string | null {
        const match = line.match(/didaId=([^&\)]+)/);
        return match ? match[1] : null;
    }

    extractTaskTitle(line: string): string {
        const parsed = parseTaskLine(line);
        if (parsed) return this.normalizeTitle(parsed.title);
        let text = line.replace(/^(\s*>)?\s*[-*]\s\[.\]\s*/, "");
        text = text.replace(/\[[^\]]*Dida\]\(obsidian:\/\/dida-task\?didaId=[^\)]*\).*/, "");
        text = text.replace(/\s+\d{4}-\d{2}-\d{2}\s*$/, "");
        return this.normalizeTitle(text);
    }

    async resolveTargetContext(file: TFile): Promise<TaskNoteSyncResolvedContext | null> {
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatterContext = resolveTaskNoteContextFromFrontmatter(cache?.frontmatter);
        if (frontmatterContext) return this.toResolvedContext(frontmatterContext);

        const content = await this.app.vault.cachedRead(file);
        const titleContext = this.parseRangeContextFromContent(content);
        if (titleContext) return titleContext;

        const fileNameContext = resolveTaskNoteContextFromLegacyFileName(file.basename);
        if (fileNameContext) return this.toResolvedContext(fileNameContext);

        const legacyDateContext = resolveTaskNoteContextFromLegacyDate(cache?.frontmatter?.date || cache?.frontmatter?.data);
        if (legacyDateContext) return this.toResolvedContext(legacyDateContext);

        return null;
    }

    async resolveTargetDate(file: TFile): Promise<string | null> {
        const context = await this.resolveTargetContext(file);
        return context ? context.baseDate : null;
    }

    createRange(type: TaskNoteSyncRangeType, baseDate: string, endDate?: string): TaskNoteSyncRange {
        const base = this.parseDateOnly(baseDate);
        if (type === "day") return { type, startDate: baseDate, endDate: baseDate };
        if (type === "week") {
            return { type, ...getTaskNoteWeekRange(baseDate, this.plugin.settings.taskNoteSyncWeekStart || "monday") };
        }
        if (type === "month") {
            const start = new Date(base.getFullYear(), base.getMonth(), 1);
            const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
            return { type, startDate: this.formatDateOnly(start), endDate: this.formatDateOnly(end) };
        }
        if (type === "year") {
            return { type, startDate: `${base.getFullYear()}-01-01`, endDate: `${base.getFullYear()}-12-31` };
        }

        const start = this.parseDateOnly(baseDate);
        const end = this.parseDateOnly(endDate || baseDate);
        if (end.getTime() < start.getTime()) {
            return { type, startDate: this.formatDateOnly(end), endDate: this.formatDateOnly(start) };
        }
        return { type, startDate: this.formatDateOnly(start), endDate: this.formatDateOnly(end) };
    }

    selectTasksForRange(tasks: DidaTask[], range: TaskNoteSyncRange, projectKeys: string[] = [], shouldFilterProjects = false): DidaTask[] {
        const start = this.parseDateOnly(range.startDate).getTime();
        const end = this.parseDateOnly(range.endDate).getTime();
        return tasks
            .filter(task => {
                if (shouldFilterProjects && !this.matchesProjectFilter(task, projectKeys)) return false;
                const taskDate = this.getTaskLocalDate(task);
                if (!taskDate) return false;
                const time = this.parseDateOnly(taskDate).getTime();
                return time >= start && time <= end;
            })
            .sort((a, b) => {
                const da = this.getTaskLocalDate(a) || "";
                const db = this.getTaskLocalDate(b) || "";
                if (da !== db) return da.localeCompare(db);
                return (a.title || "").localeCompare(b.title || "");
            });
    }

    matchesProjectFilter(task: DidaTask, projectKeys: string[]) {
        if (!Array.isArray(projectKeys) || projectKeys.length === 0) return false;
        const info = this.plugin.resolveTaskProjectInfo(task);
        return this.plugin.getProjectFilterKeyAliases(info.id, info.name).some((key) => projectKeys.includes(key));
    }

    getTaskLocalDate(task: DidaTask): string | null {
        const dateStr = task.dueDate || task.startDate;
        if (!dateStr) return null;
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return null;
        return this.formatDateOnly(date);
    }

    formatGroupedTasks(tasks: DidaTask[], taskPrefix: string, isCallout: boolean): string[] {
        const lines: string[] = [];
        let currentDate = "";
        for (const task of tasks) {
            const taskDate = this.getTaskLocalDate(task);
            if (!taskDate) continue;
            if (taskDate !== currentDate) {
                currentDate = taskDate;
                lines.push(`${isCallout ? "> " : ""}### ${taskDate}`);
            }
            lines.push(...this.formatTasks([task], taskDate, taskPrefix));
        }
        return lines;
    }

    insertGroupedTasks(lines: string[], parsed: ParsedTaskBlock, tasks: DidaTask[], taskPrefix: string, isCallout: boolean) {
        const tasksByDate = new Map<string, DidaTask[]>();
        for (const task of tasks) {
            const taskDate = this.getTaskLocalDate(task);
            if (!taskDate) continue;
            if (!tasksByDate.has(taskDate)) tasksByDate.set(taskDate, []);
            tasksByDate.get(taskDate)!.push(task);
        }

        const insertions: Array<{ index: number; taskDate: string; lines: string[] }> = [];
        for (const [taskDate, dateTasks] of tasksByDate.entries()) {
            const existingGroup = parsed.dateGroups.get(taskDate);
            if (existingGroup) {
                insertions.push({
                    index: existingGroup.insertLineIndex,
                    taskDate,
                    lines: this.formatTasks(dateTasks, taskDate, taskPrefix)
                });
            } else {
                insertions.push({
                    index: parsed.insertLineIndex,
                    taskDate,
                    lines: [
                        `${isCallout ? "> " : ""}### ${taskDate}`,
                        ...this.formatTasks(dateTasks, taskDate, taskPrefix)
                    ]
                });
            }
        }

        insertions
            .sort((a, b) => {
                if (a.index !== b.index) return b.index - a.index;
                return b.taskDate.localeCompare(a.taskDate);
            })
            .forEach((insertion) => {
                lines.splice(insertion.index, 0, ...insertion.lines);
            });
    }

    formatTasks(tasks: DidaTask[], targetDate: string, prefix: string): string[] {
        if (tasks.length === 0) return [`${prefix}无待办任务`];

        return tasks.map(task => {
            const quotePrefix = prefix.trimStart().startsWith(">") ? "> " : "";
            const normalizedTask = {
                ...task,
                title: this.normalizeTitle(task.title),
                didaId: task.didaId || task.id,
                dueDate: task.dueDate || task.startDate || `${targetDate}T00:00:00+0800`,
                startDate: task.startDate || task.dueDate || `${targetDate}T00:00:00+0800`,
                isAllDay: task.isAllDay !== false,
                status: task.status === 2 || task.completed === true ? 2 : 0
            };
            return formatTaskLineFromTask(normalizedTask as DidaTask, "", quotePrefix);
        });
    }

    formatDidaBlockTasks(tasks: DidaTask[], range: TaskNoteSyncRange, isCallout: boolean): string[] {
        const taskPrefix = isCallout ? "> - " : "- ";
        if (tasks.length === 0) return [isCallout ? quoteCalloutLine("- [ ] 无待办任务") : "- [ ] 无待办任务"];
        if (range.startDate === range.endDate) return this.formatTasks(tasks, range.startDate, taskPrefix);
        return this.formatGroupedTasks(tasks, taskPrefix, isCallout);
    }

    formatDidaBlockRange(range: TaskNoteSyncRange): string {
        return range.startDate === range.endDate
            ? range.startDate
            : `${range.startDate} ~ ${range.endDate}`;
    }

    extractDidaBlockHeader(line: string): string {
        const trimmed = (line || "").trim();
        const jsonIndex = trimmed.indexOf("{");
        return jsonIndex >= 0 ? trimmed.slice(0, jsonIndex).trim() : trimmed;
    }

    getRangeTitle(range: TaskNoteSyncRange): string {
        if (range.type === "day") return range.startDate;
        if (range.type === "week") return this.getWeekStem(range.startDate);
        if (range.type === "month") return range.startDate.slice(0, 7);
        if (range.type === "year") return range.startDate.slice(0, 4);
        return `${range.startDate} to ${range.endDate}`;
    }

    getWeekStem(dateStr: string): string {
        return getTaskNoteWeekStem(dateStr, this.plugin.settings.taskNoteSyncWeekStart || "monday");
    }

    getWeekPatternInfo(dateStr: string): { year: number; week: number } {
        return getTaskNoteWeekInfo(dateStr, this.plugin.settings.taskNoteSyncWeekStart || "monday");
    }

    parseDateOnly(dateStr: string): Date {
        return parseDateOnly(dateStr);
    }

    formatDateOnly(date: Date): string {
        return formatDateOnly(date);
    }

    parseRangeContextFromContent(content: string): TaskNoteSyncResolvedContext | null {
        const match = content.match(/^#\s+(.+)$/m);
        if (!match) return null;
        const context = resolveTaskNoteContextFromTitle(match[1].trim(), this.plugin.settings.taskNoteSyncWeekStart || "monday");
        return context ? this.toResolvedContext(context) : null;
    }

    toResolvedContext(context: TaskNoteResolvedContext): TaskNoteSyncResolvedContext {
        return {
            rangeType: context.rangeType,
            baseDate: context.baseDate,
            startDate: context.startDate,
            endDate: context.endDate
        };
    }

    normalizeTitle(title: string): string {
        return (title || "").replace(/\n/g, " ").trim();
    }
}
