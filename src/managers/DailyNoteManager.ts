import { App, Notice, TFile } from "obsidian";
import DidaSyncPlugin from "../main";
import { DidaTask } from "../types";

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
            const taskPrefix = isCallout ? "> - " : "- ";

            const tasks = this.selectTasksForDate(this.plugin.settings.tasks, targetDate);
            const formattedTasks = this.formatTasks(tasks, targetDate, taskPrefix);

            await this.replaceTaskBlockUnderHeader(activeFile, targetHeader, formattedTasks, isCallout);

            if (tasks.length === 0) {
                new Notice("今日无待办任务");
            } else {
                new Notice(`成功同步 ${tasks.length} 个任务到日记`);
            }
        } catch (e) {
            console.error(e);
            new Notice(`同步失败: ${e instanceof Error ? e.message : "未知错误"}`);
        }
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

    async replaceTaskBlockUnderHeader(file: TFile, targetHeader: string, newLines: string[], isCallout: boolean) {
        await this.app.vault.process(file, (data) => {
            const lines = data.split("\n");
            // Find header index
            const headerIndex = lines.findIndex(line => line.trim().startsWith(targetHeader.trim()));

            if (headerIndex === -1) {
                throw new Error(`当前文档未找到 '${targetHeader}' 区块`);
            }

            const startIndex = headerIndex + 1;
            let endIndex = startIndex;

            // Consume existing task lines
            while (endIndex < lines.length) {
                const line = lines[endIndex].trim();
                let shouldConsume = false;

                if (isCallout) {
                    // For callouts, consume lines starting with ">"
                    // But be careful not to consume a NEW callout header (e.g. > [!info] Next)
                    // We assume tasks are > - ... or continuation > ...
                    // If it hits a new callout type syntax > [!...] stop? 
                    // Simple logic: consume > - or > lines until non-> line or new header
                    if (line.startsWith(">")) {
                        // Check if it's potentially a new callout header
                        if (line.match(/^>\s*\[!.*\]/)) {
                            shouldConsume = false;
                        } else {
                            shouldConsume = true;
                        }
                    }
                } else {
                    // For normal headers, consume lines starting with "- [ ]" or "- [x]" or "- "
                    // Also maybe numbered lists? Sticking to bullets for now.
                    if (line.startsWith("- [") || line.startsWith("- ")) {
                        shouldConsume = true;
                    }
                }

                if (shouldConsume) {
                    endIndex++;
                } else {
                    break;
                }
            }

            // Insert new lines
            lines.splice(startIndex, endIndex - startIndex, ...newLines);
            return lines.join("\n");
        });
    }
}
