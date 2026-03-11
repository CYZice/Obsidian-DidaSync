import { App, Notice, TFile } from "obsidian";
import DidaSyncPlugin from "../main";
import { DidaTask } from "../types";

interface ParsedTaskBlock {
    hasHeader: boolean;
    headerLineIndex: number;
    insertLineIndex: number; // Position to insert new tasks
    existingTaskIds: Set<string>; // didaId set
    existingTaskTitles: Set<string>; // title set (normalized)
    hasExistingContent: boolean; // if there are any tasks or content in the block
}

export class DailyNoteManager {
    app: App;
    plugin: DidaSyncPlugin;

    constructor(app: App, plugin: DidaSyncPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    async syncTodayTasksToActiveNote() {
        try {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice("没有打开的文档，无法同步");
                return;
            }

            const targetDate = await this.resolveTargetDate(activeFile);
            if (!targetDate) {
                new Notice("无法识别当前文档对应的日期，请检查文件名(YYYY-MM-DD)或frontmatter里的date字段");
                return;
            }

            const targetHeader = this.plugin.settings.dailySyncTargetBlockHeader;
            const isCallout = targetHeader.trim().startsWith(">");

            // Get tasks for the target date
            const tasks = this.selectTasksForDate(this.plugin.settings.tasks, targetDate);

            // Use new smart append logic
            await this.smartAppendTasksToHeader(activeFile, targetHeader, tasks, targetDate, isCallout);

        } catch (e) {
            console.error(e);
            new Notice(`同步失败: ${e instanceof Error ? e.message : "未知错误"}`);
        }
    }

    async smartAppendTasksToHeader(file: TFile, targetHeader: string, fetchedTasks: DidaTask[], targetDate: string, isCallout: boolean) {
        await this.app.vault.process(file, (data) => {
            const lines = data.split("\n");
            const parsed = this.parseExistingTaskBlock(lines, targetHeader);

            if (!parsed.hasHeader) {
                throw new Error(`当前文档未找到 '${targetHeader}' 区块`);
            }

            // Deduplication
            const tasksToAppend: DidaTask[] = [];
            for (const task of fetchedTasks) {
                const didaId = task.didaId || task.id;
                // Normalize title: remove newlines, trim
                const title = task.title.replace(/\n/g, " ").trim();

                // 1. Strong Match: ID
                if (didaId && parsed.existingTaskIds.has(didaId)) {
                    continue;
                }
                // 2. Weak Match: Title
                if (parsed.existingTaskTitles.has(title)) {
                    continue;
                }

                tasksToAppend.push(task);
            }

            const taskPrefix = isCallout ? "> - " : "- ";

            if (tasksToAppend.length === 0) {
                // No new tasks to add
                if (fetchedTasks.length === 0 && !parsed.hasExistingContent) {
                    // Case: No tasks fetched AND no existing content -> Write "No tasks" placeholder
                    const noTaskLine = `${taskPrefix}无待办任务`;
                    // Check if "No tasks" already exists to avoid duplication? 
                    // parsed.hasExistingContent covers this if "No tasks" is treated as content.
                    // But "No tasks" usually doesn't match isTaskLine, so hasExistingContent=true (as note).
                    // So we probably don't need to do anything if "No tasks" is already there.
                    // But if parsed.hasExistingContent is FALSE (empty block), we add it.
                    lines.splice(parsed.insertLineIndex, 0, noTaskLine);
                    new Notice("今日无待办任务");
                    return lines.join("\n");
                }
                // Case: All duplicate or Empty fetch but has content -> Do nothing
                new Notice("没有新任务需要同步");
                return lines.join("\n");
            }

            // Append new tasks
            const newLines = this.formatTasks(tasksToAppend, targetDate, taskPrefix);

            // Insert
            lines.splice(parsed.insertLineIndex, 0, ...newLines);
            new Notice(`成功同步 ${tasksToAppend.length} 个新任务`);
            return lines.join("\n");
        });
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
                hasExistingContent: false
            };
        }

        const existingTaskIds = new Set<string>();
        const existingTaskTitles = new Set<string>();
        let insertLineIndex = headerIndex + 1;
        let hasExistingContent = false;

        // Scan subsequent lines
        for (let i = headerIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Check if end of block: Next Header
            // We assume headers start with #
            if (trimmed.startsWith("#")) break;

            const isTask = this.isTaskLine(trimmed);

            if (isTask) {
                // Extract info
                const id = this.extractDidaId(trimmed);
                if (id) existingTaskIds.add(id);

                const title = this.extractTaskTitle(trimmed);
                if (title) existingTaskTitles.add(title);

                hasExistingContent = true;
                // Update insertion point to be after this task
                insertLineIndex = i + 1;
            } else {
                // Non-task line
                if (trimmed !== "") {
                    // Content exists (could be a note, or "No tasks" text)
                    hasExistingContent = true;
                    // We do NOT update insertLineIndex here, 
                    // so new tasks will be inserted BEFORE these notes 
                    // (if they are after the last task).
                    // Wait, PRD says: "Append to end of existing task list... preserving user notes".
                    // If we have:
                    // - Task A
                    // Note B
                    // We want:
                    // - Task A
                    // - New Task
                    // Note B
                    // So `insertLineIndex` staying at `i` (after Task A) is correct.
                }
            }
        }

        return {
            hasHeader: true,
            headerLineIndex: headerIndex,
            insertLineIndex,
            existingTaskIds,
            existingTaskTitles,
            hasExistingContent
        };
    }

    private isTaskLine(line: string): boolean {
        // Matches "- [ ]", "- [x]", "> - [ ]", "* [ ]"
        return /^(\s*>)?\s*[-*]\s\[.\]/.test(line);
    }

    private extractDidaId(line: string): string | null {
        // Matches didaId=... inside the link
        const match = line.match(/didaId=([^&\)]+)/);
        return match ? match[1] : null;
    }

    private extractTaskTitle(line: string): string {
        // Remove Checkbox prefix
        let text = line.replace(/^(\s*>)?\s*[-*]\s\[.\]\s*/, "");

        // Remove Dida Link and Date if present
        // Format: Title [🔗Dida](...) 📅 ...
        // We split by [🔗Dida] to be safe
        const parts = text.split("[🔗Dida]");
        if (parts.length > 0) {
            text = parts[0].trim();
        }
        return text;
    }

    async resolveTargetDate(file: TFile): Promise<string | null> {
        // 1. Try filename
        const name = file.basename;
        const nameMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
        if (nameMatch) {
            return nameMatch[1];
        }

        // 2. Try frontmatter
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache && cache.frontmatter) {
            if (cache.frontmatter.date) {
                const d = new Date(cache.frontmatter.date);
                if (!isNaN(d.getTime())) {
                    return d.toISOString().split('T')[0];
                }
            }
            // Fallback to 'data' field as per Daily Task Sync legacy
            if (cache.frontmatter.data) {
                const d = new Date(cache.frontmatter.data);
                if (!isNaN(d.getTime())) {
                    return d.toISOString().split('T')[0];
                }
            }
        }

        return null;
    }

    selectTasksForDate(tasks: DidaTask[], targetDate: string): DidaTask[] {
        return tasks.filter(task => {
            const dateStr = task.dueDate || task.startDate;
            if (!dateStr) return false;

            const tDate = new Date(dateStr);
            if (isNaN(tDate.getTime())) return false;

            // Convert to local YYYY-MM-DD
            const y = tDate.getFullYear();
            const m = String(tDate.getMonth() + 1).padStart(2, '0');
            const d = String(tDate.getDate()).padStart(2, '0');
            const localDateStr = `${y}-${m}-${d}`;

            return localDateStr === targetDate;
        });
    }

    formatTasks(tasks: DidaTask[], targetDate: string, prefix: string): string[] {
        if (tasks.length === 0) {
            // For callouts, we might want "> - 无待办任务" or similar, for plain lists maybe just "无待办任务"
            // But let's stick to the prefix for consistency
            return [`${prefix}无待办任务`];
        }

        return tasks.map(task => {
            const isCompleted = task.status === 2 || task.completed === true;
            const statusIcon = isCompleted ? "x" : " ";
            const title = task.title.replace(/\n/g, " "); // Flatten multiline titles
            const didaId = task.didaId || task.id;

            // Format: PREFIX [x] Title [🔗Dida](obsidian://dida-task?didaId=...) 📅 YYYY-MM-DD
            return `${prefix}[${statusIcon}] ${title} [🔗Dida](obsidian://dida-task?didaId=${didaId}) 📅 ${targetDate}`;
        });
    }


}
