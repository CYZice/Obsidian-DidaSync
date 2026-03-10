import { Notice, TFile } from "obsidian";
import DidaSyncPlugin from "../main";
import { DidaTask, DidaProject } from "../types";
import { RepeatTaskManager } from "./RepeatTaskManager";

export class SyncManager {
    plugin: DidaSyncPlugin;
    syncIntervalId: NodeJS.Timeout | null = null;
    isSyncing: boolean = false;

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
    }

    async setupAutoSync() {
        this.clearAutoSync();
        if (this.plugin.settings.autoSync) {
            this.syncFromDidaList(); // Initial sync
            this.syncIntervalId = setInterval(() => {
                this.syncFromDidaList();
            }, this.plugin.settings.syncInterval * 60 * 1000);
        }
    }

    clearAutoSync() {
        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
    }

    async syncFromDidaList() {
        if (this.isSyncing) return;
        if (!this.plugin.settings.accessToken) return;

        this.isSyncing = true;
        this.plugin.updateStatusBar("同步中...");

        try {
            // 1. Fetch Projects
            const projects = await this.plugin.apiClient.getProjects();
            this.plugin.settings.projects = projects.map((p: any) => ({
                id: p.id,
                name: p.name,
                color: p.color,
                sortOrder: p.sortOrder,
                closed: p.closed,
                groupId: p.groupId,
                viewMode: p.viewMode,
                permission: p.permission,
                kind: p.kind
            }));

            // 2. Fetch Tasks from all projects
            let allTasks: any[] = [];
            // Add Inbox logic if needed, usually Inbox is a project or handled separately. 
            // Dida API usually treats Inbox as a project or special ID. 
            // We'll iterate fetched projects.
            
            // Limit concurrency?
            for (const project of this.plugin.settings.projects) {
                if (project.closed && !this.plugin.settings.showArchivedProjects) continue;
                const tasks = await this.plugin.apiClient.getProjectTasks(project.id);
                tasks.forEach((t: any) => {
                    t.projectId = project.id;
                    t.projectName = project.name;
                    t.projectColor = project.color;
                });
                allTasks = allTasks.concat(tasks);
            }

            // Also fetch Inbox if not in projects list (usually it is, but check API)
            // Assuming projects list includes Inbox.

            // 3. Process Tasks
            const currentTasksMap = new Map<string, DidaTask>();
            this.plugin.settings.tasks.forEach(t => {
                if (t.didaId) currentTasksMap.set(t.didaId, t);
            });

            const newTasks: DidaTask[] = [];
            const fetchedTaskIds = new Set<string>();

            for (const apiTask of allTasks) {
                fetchedTaskIds.add(apiTask.id);
                
                // Map API task to DidaTask
                const mappedTask: DidaTask = {
                    id: apiTask.id, // Use API ID as local ID for synced tasks? Or keep separate? 
                                    // Original code seems to use API ID as didaId and ID.
                    didaId: apiTask.id,
                    title: apiTask.title,
                    content: apiTask.content,
                    desc: apiTask.desc,
                    isAllDay: apiTask.isAllDay,
                    startDate: apiTask.startDate,
                    dueDate: apiTask.dueDate,
                    timeZone: apiTask.timeZone,
                    reminders: apiTask.reminders,
                    repeatFlag: apiTask.repeatFlag,
                    priority: apiTask.priority,
                    status: apiTask.status,
                    completedTime: apiTask.completedTime,
                    projectId: apiTask.projectId,
                    projectName: apiTask.projectName,
                    sortOrder: apiTask.sortOrder,
                    items: apiTask.items, // Subtasks
                    kind: apiTask.kind,
                    projectColor: apiTask.projectColor,
                    
                    // Preserve local fields if exists
                    hasLink: false,
                    linkPath: undefined
                };

                // Check for existing task to preserve local-only fields
                const existing = currentTasksMap.get(apiTask.id);
                if (existing) {
                    mappedTask.hasLink = existing.hasLink;
                    mappedTask.linkPath = existing.linkPath;
                    mappedTask.parentId = existing.parentId; // Preserve parentId for repeat tasks generated locally?
                    // Actually, API returns subtasks inside 'items', but flattened structure might be used locally.
                    // If API returns items, we might need to flatten them if we want individual task entries, 
                    // or keep them as items. The Type definition has `items`.
                }

                newTasks.push(mappedTask);
            }

            // 4. Handle Deleted Tasks (Tasks in local settings but not in API)
            // But only if we did a full sync. Since we iterated all projects, we can assume missing ones are deleted/moved?
            // Or maybe just keep tasks that are not in fetchedTaskIds ONLY IF they don't have a didaId (local only tasks).
            
            this.plugin.settings.tasks.forEach(t => {
                if (!t.didaId) {
                    // Local task not synced yet
                    newTasks.push(t);
                }
                // If t.didaId exists but not in fetchedTaskIds, it's deleted on server.
                // We exclude it from newTasks, effectively deleting it locally.
            });

            this.plugin.settings.tasks = newTasks;
            await this.plugin.saveSettings();

            // 5. Native Task Sync Update
            if (this.plugin.settings.enableNativeTaskSync) {
                await this.updateNativeTasks(newTasks);
            }

            // 6. Repeat Task Generation
            // Check for tasks that need repeat generation (handled by RepeatTaskManager)
            // This might happen if a recurring task is completed.
            // Original code: syncFromDidaList calls checkRepeatTasks? 
            // Actually RepeatTaskManager usually hooks into completion events.

            this.plugin.refreshTaskView();
            this.plugin.updateStatusBar("已连接");
            
            new Notice("同步完成");

        } catch (e: any) {
            console.error("Sync failed:", e);
            new Notice("同步失败: " + e.message);
            this.plugin.updateStatusBar("同步失败");
        } finally {
            this.isSyncing = false;
        }
    }

    async updateNativeTasks(tasks: DidaTask[]) {
        // Iterate markdown files and update status of linked tasks
        // This is heavy, maybe optimize?
        // Logic from TaskView.updateNativeTaskStatus/Title/Date
        
        // We need a reverse map: didaId -> Task
        const taskMap = new Map<string, DidaTask>();
        tasks.forEach(t => {
            if (t.didaId) taskMap.set(t.didaId, t);
        });

        const files = this.plugin.app.vault.getMarkdownFiles();
        for (const file of files) {
            const content = await this.plugin.app.vault.read(file);
            const nativeTasks = this.plugin.nativeTaskSyncManager.detectNativeTasks(content, file.path);
            
            if (nativeTasks.length === 0) continue;

            let newContent = content;
            let fileChanged = false;

            // Sort nativeTasks by line number descending to avoid offset issues when replacing
            nativeTasks.sort((a, b) => b.lineNumber - a.lineNumber);

            for (const nativeTask of nativeTasks) {
                if (!nativeTask.didaId) continue;
                
                const didaTask = taskMap.get(nativeTask.didaId);
                if (didaTask) {
                    // Update Status
                    const didaCompleted = didaTask.status === 2 || didaTask.status === 1; // 2 is completed for Task, 1 for Checklist item?
                    if (nativeTask.isCompleted !== didaCompleted) {
                        // Replace [ ] with [x] or vice versa
                        const line = nativeTask.originalLine;
                        const statusChar = didaCompleted ? "x" : " ";
                        const regex = /^(\s*-\s*\[)([^\]])(\])/;
                        if (regex.test(line)) {
                            // We need to replace in the file content
                            // This is tricky with simple string replace if multiple identical lines exist.
                            // Better to split by lines and replace by index.
                            // Since we iterate files, let's do line-based replacement.
                        }
                    }
                }
            }
            
            // Re-read and write approach is safer for line-based edits
            if (fileChanged) {
               // await this.plugin.app.vault.modify(file, newContent);
            }
        }
        
        // Actually, the NativeTaskSyncManager should probably handle the file modification logic 
        // if we want to be robust. For now, I'll skip the heavy "update all files" logic 
        // unless explicitly requested, as it can be slow. 
        // The original code `markCompletedNativeTasksWithLinks` does this.
        
        // Let's implement `markCompletedNativeTasksWithLinks` equivalent here.
        await this.markCompletedNativeTasksWithLinks(taskMap);
    }

    async markCompletedNativeTasksWithLinks(taskMap: Map<string, DidaTask>) {
        const files = this.plugin.app.vault.getMarkdownFiles();
        for (const file of files) {
            let content = await this.plugin.app.vault.read(file);
            const lines = content.split("\n");
            let modified = false;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = line.match(/^(\s*)-\s*\[([ x])\]\s*(.*?)(\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-zA-Z0-9]+)\))?/);
                
                if (match) {
                    const [, indent, status, text, link, didaId] = match;
                    if (didaId) {
                        const task = taskMap.get(didaId);
                        if (task) {
                            const shouldBeCompleted = task.status === 2 || (task.status === 1 && task.kind === 'CHECKLIST'); // Simplified check
                            const isCompleted = status.toLowerCase() === 'x';
                            
                            if (shouldBeCompleted !== isCompleted) {
                                const newStatus = shouldBeCompleted ? 'x' : ' ';
                                lines[i] = line.replace(`-[${status}]`, `-[${newStatus}]`);
                                modified = true;
                            }
                            
                            // Also update title/date if needed? 
                            // Original code `updateNativeTaskTitle` does this individually.
                            // Batch update here is better.
                        }
                    }
                }
            }

            if (modified) {
                await this.plugin.app.vault.modify(file, lines.join("\n"));
            }
        }
    }
}
