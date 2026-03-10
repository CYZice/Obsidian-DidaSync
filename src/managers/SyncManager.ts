import { Notice } from "obsidian";
import DidaSyncPlugin from "../main";
import { DidaTask } from "../types";
import { TASK_VIEW_TYPE, TaskView } from "../views/TaskView";

export class SyncManager {
    plugin: DidaSyncPlugin;
    syncIntervalId: number | null = null;
    isSyncing: boolean = false;

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
    }

    async initializeSync() {
        this.setupAutoSync();
    }

    async setupAutoSync() {
        this.clearAutoSync();
        if (this.plugin.settings.autoSync && this.plugin.settings.accessToken) {
            try {
                if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) return;
            } catch (e) { }
            this.syncIntervalId = window.setInterval(() => {
                this.syncFromDidaList();
            }, 60 * this.plugin.settings.syncInterval * 1000);
        }
    }

    clearAutoSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
    }

    async syncToDidaList() {
        if (this.plugin.settings.accessToken) {
            try {
                this.plugin.updateStatusBar("同步中...");
                const tasks = this.plugin.settings.tasks || [];
                for (const task of tasks) {
                    if (task.didaId) await this.updateTaskInDidaList(task);
                    else await this.createTaskInDidaList(task);
                }
                this.plugin.updateStatusBar("已连接");
            } catch (e) {
                this.plugin.updateStatusBar("同步失败");
            }
        } else {
            new Notice("请先进行OAuth认证");
        }
    }

    async syncNewTasksToDidaList() {
        const tasks = (this.plugin.settings.tasks || []).filter(t => !t.didaId);
        if (tasks.length === 0) return;
        let created = 0;
        let errors = 0;
        for (const task of tasks) {
            try {
                await this.createTaskInDidaList(task);
                created++;
                if (created % 2 === 0) await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e: any) {
                errors++;
                if (e.message?.includes("exceed_query_limit") || e.message?.includes("500")) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
                if (errors > 3) throw new Error("同步错误过多，已停止同步");
            }
        }
    }

    async syncFromDidaList() {
        if (!this.plugin.settings.accessToken) {
            new Notice("请先进行OAuth认证");
            return;
        }
        if (this.plugin.isReverseUpdating) return;
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            this.plugin.updateStatusBar("同步中...");
            const tasks: any[] = [];
            let updatedCount = 0;
            const projectMap = new Map<string, any>();
            try {
                const res = await this.plugin.apiClient.makeAuthenticatedRequest("https://api.dida365.com/open/v1/project");
                if (res.ok) {
                    const list = await res.json();
                    if (Array.isArray(list)) {
                        list.forEach(p => {
                            projectMap.set(p.id, {
                                id: p.id,
                                name: p.name,
                                color: p.color,
                                closed: p.closed,
                                groupId: p.groupId,
                                viewMode: p.viewMode,
                                permission: p.permission,
                                kind: p.kind
                            });
                        });
                        if (!projectMap.has("inbox")) {
                            projectMap.set("inbox", {
                                id: "inbox",
                                name: "收集箱",
                                color: "#F18181",
                                closed: false,
                                groupId: null,
                                viewMode: "list",
                                permission: "write",
                                kind: "TASK"
                            });
                        }
                        for (const project of list) {
                            for (const url of [
                                `https://api.dida365.com/open/v1/project/${project.id}/task`,
                                `https://api.dida365.com/open/v1/project/${project.id}/data`,
                                `https://api.dida365.com/open/v1/task?projectId=${project.id}`
                            ]) {
                                try {
                                    const res = await this.plugin.apiClient.makeAuthenticatedRequest(url);
                                    if (res.ok) {
                                        const data = await res.json();
                                        let items: any[] = [];
                                        if (Array.isArray(data)) items = data;
                                        else if (data && data.tasks && Array.isArray(data.tasks)) items = data.tasks;
                                        else if (data && data.data && Array.isArray(data.data)) items = data.data;
                                        if (items.length > 0) {
                                            items.forEach(t => {
                                                const proj = projectMap.get(project.id);
                                                t.projectId = project.id;
                                                t.projectName = project.name;
                                                t.projectColor = proj?.color;
                                                t.projectClosed = proj?.closed;
                                                t.projectViewMode = proj?.viewMode;
                                                t.projectKind = proj?.kind;
                                                t.projectPermission = proj?.permission;
                                            });
                                            tasks.push(...items);
                                            break;
                                        }
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                }
            } catch (e) { }

            try {
                for (const url of [
                    "https://api.dida365.com/open/v1/project/inbox/task",
                    "https://api.dida365.com/open/v1/project/inbox/data",
                    "https://api.dida365.com/open/v1/task?projectId=inbox",
                    "https://api.dida365.com/open/v1/task"
                ]) {
                    try {
                        const res = await this.plugin.apiClient.makeAuthenticatedRequest(url);
                        if (res.ok) {
                            const data = await res.json();
                            let items: any[] = [];
                            if (Array.isArray(data)) items = url.includes("/task") && !url.includes("projectId") ? data.filter(t => !t.projectId || t.projectId === "inbox" || t.projectId === null) : data;
                            else if (data && data.tasks && Array.isArray(data.tasks)) items = data.tasks;
                            else if (data && data.data && Array.isArray(data.data)) items = data.data;
                            if (items.length > 0) {
                                const proj = projectMap.get("inbox");
                                items.forEach(t => {
                                    t.projectId = t.projectId || "inbox";
                                    t.projectName = "收集箱";
                                    t.projectColor = proj?.color;
                                    t.projectClosed = proj?.closed;
                                    t.projectViewMode = proj?.viewMode;
                                    t.projectKind = proj?.kind;
                                    t.projectPermission = proj?.permission;
                                });
                                const ids = new Set(tasks.map(t => t.id));
                                const extra = items.filter(t => !ids.has(t.id));
                                tasks.push(...extra);
                                break;
                            }
                        }
                    } catch (e) { }
                }
            } catch (e) { }

            if (tasks.length > 0) {
                for (const remote of tasks) {
                    const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === remote.id);
                    if (idx === -1) {
                        const proj = projectMap.get(remote.projectId) || { id: remote.projectId, name: remote.projectName || "未知项目" };
                        await this.createTaskFromDida(remote, proj);
                        updatedCount++;
                    } else {
                        const local = this.plugin.settings.tasks[idx];
                        let changed = false;
                        const shouldUpdate = (remoteTask: any, localTask: DidaTask) => {
                            if (remoteTask.etag && localTask.etag) return remoteTask.etag !== localTask.etag;
                            const r = remoteTask.modifiedTime || remoteTask.createdTime;
                            const l = localTask.updatedAt;
                            if (!r && !l) return true;
                            if (!r) return false;
                            if (!l) return true;
                            try {
                                const rd = new Date(r);
                                const ld = new Date(l);
                                return rd.getTime() - ld.getTime() < 30000;
                            } catch (e) {
                                return false;
                            }
                        };
                        if (remote.title && remote.title !== local.title && shouldUpdate(remote, local)) {
                            const oldTitle = local.title;
                            local.title = remote.title;
                            changed = true;
                            if (local.didaId) {
                                setTimeout(() => {
                                    this.plugin.isReverseUpdating = true;
                                    this.plugin.app.workspace.getLeavesOfType(TASK_VIEW_TYPE).forEach(leaf => {
                                        if (leaf.view instanceof TaskView && (leaf.view as any).updateNativeTaskTitle) {
                                            (leaf.view as any).updateNativeTaskTitle(local, oldTitle, remote.title);
                                        }
                                    });
                                    setTimeout(() => {
                                        this.plugin.isReverseUpdating = false;
                                    }, 1000);
                                }, 500);
                            }
                        }
                        if (remote.kind === "CHECKLIST") {
                            if (remote.desc !== local.desc) {
                                local.desc = remote.desc || "";
                                changed = true;
                            }
                            if (remote.content !== local.content) {
                                local.content = remote.content || "";
                                changed = true;
                            }
                        } else {
                            if (remote.content && remote.content !== local.content) {
                                local.content = remote.content;
                                changed = true;
                            }
                            if (remote.desc !== local.desc) {
                                local.desc = remote.desc || "";
                                changed = true;
                            }
                        }
                        if (remote.dueDate !== undefined && remote.dueDate !== local.dueDate && shouldUpdate(remote, local)) {
                            const oldDue = local.dueDate;
                            local.dueDate = remote.dueDate;
                            changed = true;
                            if (local.didaId) {
                                setTimeout(() => {
                                    this.plugin.app.workspace.getLeavesOfType(TASK_VIEW_TYPE).forEach(leaf => {
                                        if (leaf.view instanceof TaskView && (leaf.view as any).updateNativeTaskDueDate) {
                                            (leaf.view as any).updateNativeTaskDueDate(local, oldDue, remote.dueDate);
                                        }
                                    });
                                }, 100);
                            }
                        }
                        if (remote.startDate !== undefined && remote.startDate !== local.startDate) {
                            local.startDate = remote.startDate;
                            changed = true;
                        }
                        if (remote.etag !== undefined && remote.etag !== local.etag) {
                            local.etag = remote.etag;
                            changed = true;
                        }
                        if (remote.isAllDay !== undefined && remote.isAllDay !== local.isAllDay) {
                            local.isAllDay = remote.isAllDay;
                            changed = true;
                        }
                        if (remote.kind !== undefined && remote.kind !== local.kind) {
                            local.kind = remote.kind;
                            changed = true;
                        }
                        if (remote.reminders !== undefined && JSON.stringify(remote.reminders) !== JSON.stringify(local.reminders)) {
                            local.reminders = remote.reminders;
                            changed = true;
                        }
                        if (remote.repeatFlag !== undefined && remote.repeatFlag !== local.repeatFlag) {
                            local.repeatFlag = remote.repeatFlag;
                            changed = true;
                        }
                        if (remote.status !== undefined && remote.status !== local.status) {
                            local.status = remote.status;
                            changed = true;
                        }
                        if (remote.status === 2) {
                            if (remote.completedTime) {
                                let completed: string | null = null;
                                if (typeof remote.completedTime === "number") {
                                    const dt = new Date(remote.completedTime);
                                    const y = dt.getFullYear();
                                    const m = String(dt.getMonth() + 1).padStart(2, "0");
                                    const d = String(dt.getDate()).padStart(2, "0");
                                    const h = String(dt.getHours()).padStart(2, "0");
                                    const min = String(dt.getMinutes()).padStart(2, "0");
                                    const s = String(dt.getSeconds()).padStart(2, "0");
                                    const offset = dt.getTimezoneOffset();
                                    const oh = Math.abs(Math.floor(offset / 60));
                                    const om = Math.abs(offset % 60);
                                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                                    completed = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                                } else if (typeof remote.completedTime === "string") {
                                    completed = remote.completedTime;
                                }
                                if (completed && local.completedTime !== completed) {
                                    local.completedTime = completed;
                                    changed = true;
                                }
                            } else if (local.completedTime) {
                                local.completedTime = null;
                                changed = true;
                            }
                        } else if (local.completedTime) {
                            local.completedTime = null;
                            changed = true;
                        }
                        if (remote.projectId !== undefined && remote.projectId !== local.projectId) {
                            local.projectId = remote.projectId;
                            changed = true;
                        }
                        if (remote.projectName !== undefined && remote.projectName !== local.projectName) {
                            local.projectName = remote.projectName;
                            changed = true;
                        }
                        if (remote.projectColor !== undefined && remote.projectColor !== local.projectColor) {
                            local.projectColor = remote.projectColor;
                            changed = true;
                        }
                        if (remote.projectClosed !== undefined && remote.projectClosed !== local.projectClosed) {
                            local.projectClosed = remote.projectClosed;
                            changed = true;
                        }
                        if (remote.projectViewMode !== undefined && remote.projectViewMode !== local.projectViewMode) {
                            local.projectViewMode = remote.projectViewMode;
                            changed = true;
                        }
                        if (remote.projectKind !== undefined && remote.projectKind !== local.projectKind) {
                            local.projectKind = remote.projectKind;
                            changed = true;
                        }
                        if (remote.projectPermission !== undefined && remote.projectPermission !== local.projectPermission) {
                            local.projectPermission = remote.projectPermission;
                            changed = true;
                        }
                        if (remote.items !== undefined && JSON.stringify(remote.items) !== JSON.stringify(local.items)) {
                            const mappedItems = remote.items.map((item: any) => {
                                if (item.completedTime && typeof item.completedTime === "number") {
                                    const dt = new Date(item.completedTime);
                                    const y = dt.getFullYear();
                                    const m = String(dt.getMonth() + 1).padStart(2, "0");
                                    const d = String(dt.getDate()).padStart(2, "0");
                                    const h = String(dt.getHours()).padStart(2, "0");
                                    const min = String(dt.getMinutes()).padStart(2, "0");
                                    const s = String(dt.getSeconds()).padStart(2, "0");
                                    const offset = dt.getTimezoneOffset();
                                    const oh = Math.abs(Math.floor(offset / 60));
                                    const om = Math.abs(offset % 60);
                                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                                    return { ...item, completedTime: `${y}-${m}-${d}T${h}:${min}:${s}${tz}` };
                                }
                                return item;
                            });
                            local.items = mappedItems;
                            changed = true;
                        }
                        if (remote.parentId !== undefined && remote.parentId !== local.parentId) {
                            local.parentId = remote.parentId;
                            changed = true;
                        }
                        if (changed) {
                            local.updatedAt = new Date().toISOString();
                            if (remote.etag) local.etag = remote.etag;
                            await this.plugin.saveSettings();
                            updatedCount++;
                        }
                    }
                }
            }

            const deletedCount = await this.syncDeletedTasks(tasks);
            const extraCount = await this.markExtraTasksAsCompleted(tasks);
            const nativeCount = await this.markCompletedNativeTasksWithLinks(tasks);
            if (updatedCount > 0 || deletedCount > 0 || extraCount > 0 || nativeCount > 0) {
                this.plugin.updateStatusBar("已连接");
                this.plugin.refreshTaskView();
            }
        } catch (e: any) {
            this.plugin.updateStatusBar("同步失败");
        } finally {
            this.isSyncing = false;
        }
    }

    async syncDeletedTasks(tasks: any[]) {
        const remoteIds = new Set(tasks.map(t => t.id));
        const toDelete = this.plugin.settings.tasks.filter(t => t.didaId).filter(t => {
            if (remoteIds.has(t.didaId as string)) return false;
            if (t.status === 2) {
                if (t.items && Array.isArray(t.items) && t.items.length > 0) return false;
                if (this.plugin.settings.tasks.some(x => x.parentId === t.didaId)) return false;
                return false;
            }
            if (t.updatedAt) {
                const updated = new Date(t.updatedAt);
                if ((Date.now() - updated.getTime()) / 3600000 < 24) return false;
            }
            return true;
        });
        if (toDelete.length === 0) return 0;
        let count = 0;
        for (const task of toDelete) {
            try {
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                if (idx !== -1) {
                    this.plugin.settings.tasks.splice(idx, 1);
                    count++;
                }
            } catch (e) { }
        }
        if (count > 0) await this.plugin.saveSettings();
        return count;
    }

    async markExtraTasksAsCompleted(tasks: any[]) {
        const remoteIds = new Set(tasks.map(t => t.id));
        const extra = this.plugin.settings.tasks.filter(t => t.didaId).filter(t => !remoteIds.has(t.didaId as string) && t.status !== 2);
        if (extra.length === 0) return 0;
        let count = 0;
        for (const task of extra) {
            try {
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                if (idx !== -1) {
                    const now = new Date();
                    const y = now.getFullYear();
                    const m = String(now.getMonth() + 1).padStart(2, "0");
                    const d = String(now.getDate()).padStart(2, "0");
                    const h = String(now.getHours()).padStart(2, "0");
                    const min = String(now.getMinutes()).padStart(2, "0");
                    const s = String(now.getSeconds()).padStart(2, "0");
                    const offset = now.getTimezoneOffset();
                    const oh = Math.abs(Math.floor(offset / 60));
                    const om = Math.abs(offset % 60);
                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                    this.plugin.settings.tasks[idx].status = 2;
                    if (!this.plugin.settings.tasks[idx].parentId) {
                        this.plugin.settings.tasks[idx].completedTime = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                    }
                    this.plugin.settings.tasks[idx].updatedAt = new Date().toISOString();
                    count++;
                }
            } catch (e) { }
        }
        if (count > 0) await this.plugin.saveSettings();
        return count;
    }

    async markCompletedNativeTasksWithLinks(tasks: any[]) {
        if (!Array.isArray(tasks) || tasks.length === 0) return 0;
        const remoteIds = new Set(tasks.map(t => t.id));
        let count = 0;
        try {
            for (const file of this.plugin.app.vault.getMarkdownFiles()) {
                try {
                    const content = await this.plugin.app.vault.read(file);
                    const nativeTasks = this.plugin.nativeTaskSyncManager.detectNativeTasks(content, file.path).filter(t => t.hasLink && t.didaId && !t.isCompleted && !remoteIds.has(t.didaId));
                    if (nativeTasks.length > 0) {
                        const lines = content.split("\n");
                        for (const nativeTask of nativeTasks) {
                            const lineNumber = nativeTask.lineNumber;
                            if (lineNumber < lines.length) {
                                const line = lines[lineNumber];
                                const replaced = line.replace(/^(\s*-\s*)\[\s*\](\s*.*)$/, "$1[x]$2");
                                if (replaced !== line) {
                                    lines[lineNumber] = replaced;
                                    count++;
                                }
                            }
                        }
                        if (count > 0) {
                            const newContent = lines.join("\n");
                            await this.plugin.app.vault.modify(file, newContent);
                        }
                    }
                } catch (e) { }
            }
        } catch (e) { }
        return count;
    }

    async deleteTaskInBackground(taskId: string, projectId: string) {
        try {
            await this.deleteTaskInDidaList(taskId, projectId);
            try {
                await this.syncFromDidaList();
            } catch (e) { }
        } catch (e) { }
    }

    async createTaskInDidaList(task: DidaTask) {
        let content = task.content || "";
        let desc = task.desc || "";
        if (task.items && Array.isArray(task.items) && task.items.length > 0) {
            const merged = task.content || task.desc || "";
            content = merged;
            desc = merged;
        }
        const payload: any = {
            title: task.title,
            content,
            desc
        };
        if (task.projectId && task.projectId !== "inbox") payload.projectId = task.projectId;
        if (task.parentId) payload.parentId = task.parentId;
        if (task.items && Array.isArray(task.items)) payload.items = task.items;
        if (task.dueDate !== undefined) {
            if (task.dueDate === null) payload.dueDate = null;
            else {
                let date = task.dueDate;
                if (date instanceof Date) date = date.toISOString() as any;
                if (typeof date === "string" && date.endsWith("Z")) date = date.replace("Z", "+0000");
                payload.dueDate = date;
            }
        }
        if (task.startDate !== undefined) {
            if (task.startDate === null) payload.startDate = null;
            else {
                let date = task.startDate;
                if (date instanceof Date) date = date.toISOString() as any;
                if (typeof date === "string" && date.endsWith("Z")) date = date.replace("Z", "+0000");
                payload.startDate = date;
            }
        }
        if (task.isAllDay !== undefined) payload.isAllDay = task.isAllDay;
        if (typeof task.repeatFlag === "string") {
            const rf = task.repeatFlag.trim();
            payload.repeatFlag = rf === "" ? "" : rf;
        }
        try {
            const res = await this.plugin.apiClient.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task", {
                method: "POST",
                body: JSON.stringify(payload)
            } as any);
            if (res.ok) {
                const data = await res.json();
                task.didaId = data.id;
                task.updatedAt = new Date().toISOString();
                task.etag = data.etag || null;
                task.status = data.status || 0;
                if (!task.parentId) task.completedTime = data.completedTime || null;
                task.dueDate = data.dueDate || null;
                task.startDate = data.startDate || null;
                task.isAllDay = data.isAllDay || false;
                task.kind = data.kind || "TEXT";
                task.projectViewMode = data.projectViewMode || "list";
                task.projectKind = data.projectKind || "TASK";
                task.parentId = data.parentId || null;
                if (data.items && Array.isArray(data.items) && data.items.length > 0) task.items = data.items;
                task.reminders = data.reminders || [];
                task.repeatFlag = data.repeatFlag || null;
                await this.plugin.saveSettings();
                return data;
            }
            const errorText = await res.text();
            throw new Error(`创建任务失败: ${res.status} - ${errorText}`);
        } catch (e) {
            throw e;
        }
    }

    async updateTaskInDidaList(task: DidaTask) {
        if (task.didaId) {
            const hasTimeRange = !!(task.startDate && task.dueDate && task.startDate !== task.dueDate);
            let content = task.content || task.desc || "";
            const payload: any = {
                id: task.didaId,
                title: task.title,
                content,
                desc: content,
                status: task.status
            };
            if (task.projectId && task.projectId !== "inbox") payload.projectId = task.projectId;
            if (task.dueDate !== undefined) {
                if (task.dueDate === null) payload.dueDate = null;
                else {
                    let date = task.dueDate;
                    if (date instanceof Date) date = date.toISOString() as any;
                    if (typeof date === "string" && date.endsWith("Z")) date = date.replace("Z", "+0000");
                    payload.dueDate = date;
                }
            }
            if (task.startDate !== undefined) {
                if (task.startDate === null) payload.startDate = null;
                else {
                    let date = task.startDate;
                    if (date instanceof Date) date = date.toISOString() as any;
                    if (typeof date === "string" && date.endsWith("Z")) date = date.replace("Z", "+0000");
                    payload.startDate = date;
                }
            } else if (task.dueDate !== undefined) {
                payload.startDate = payload.dueDate;
            }
            if (task.isAllDay !== undefined) {
                payload.isAllDay = task.isAllDay;
                if (task.isAllDay) payload.timeZone = "Asia/Shanghai";
            }
            if (task.parentId) payload.parentId = task.parentId;
            if (task.items && Array.isArray(task.items)) payload.items = task.items;
            if (task.reminders && Array.isArray(task.reminders)) payload.reminders = task.reminders;
            if (typeof task.repeatFlag === "string") {
                const rf = task.repeatFlag.trim();
                payload.repeatFlag = rf === "" ? "" : rf;
            }
            if (task.status === 2 && !task.parentId && !task.completedTime) {
                const now = new Date();
                const y = now.getFullYear();
                const m = String(now.getMonth() + 1).padStart(2, "0");
                const d = String(now.getDate()).padStart(2, "0");
                const h = String(now.getHours()).padStart(2, "0");
                const min = String(now.getMinutes()).padStart(2, "0");
                const s = String(now.getSeconds()).padStart(2, "0");
                const offset = now.getTimezoneOffset();
                const oh = Math.abs(Math.floor(offset / 60));
                const om = Math.abs(offset % 60);
                const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                const completed = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                task.completedTime = payload.completedTime = completed;
            }
            try {
                const res = await this.plugin.apiClient.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task/" + task.didaId, {
                    method: "POST",
                    body: JSON.stringify(payload)
                } as any);
                if (!res.ok) {
                    await res.text();
                    throw new Error("更新任务失败: " + res.status);
                }
                const data = await res.json();
                if (!hasTimeRange) {
                    if (data.dueDate !== undefined) task.dueDate = data.dueDate;
                    if (data.startDate !== undefined) task.startDate = data.startDate;
                    if (task.dueDate && !task.startDate) task.startDate = task.dueDate;
                    if (task.startDate && !task.dueDate) task.dueDate = task.startDate;
                }
                task.updatedAt = new Date().toISOString();
                await this.plugin.saveSettings();
            } catch (e) {
                throw e;
            }
        }
    }

    async deleteTaskInDidaList(taskId: string, projectId: string = "inbox") {
        try {
            const res = await this.plugin.apiClient.makeAuthenticatedRequest(`https://api.dida365.com/open/v1/project/${projectId}/task/${taskId}`, {
                method: "DELETE"
            } as any);
            if (!res.ok) throw new Error("删除任务失败: " + res.status);
        } catch (e) {
            throw e;
        }
    }

    async createTaskFromDida(task: any, project: any = null) {
        let content = task.content || "";
        let desc = task.desc || "";
        if (task.items && Array.isArray(task.items) && task.items.length > 0) {
            const merged = content || desc || "";
            content = merged;
            desc = merged;
        }
        const newTask: DidaTask = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            title: task.title,
            content,
            desc,
            didaId: task.id,
            projectId: task.projectId || "inbox",
            projectName: project ? project.name : task.projectName || "收集箱",
            createdAt: task.createdTime || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            dueDate: task.dueDate || null,
            startDate: task.startDate || null,
            etag: task.etag || null,
            isAllDay: task.isAllDay || false,
            kind: task.kind || "TEXT",
            reminders: task.reminders || [],
            repeatFlag: task.repeatFlag || null,
            status: task.status || 0,
            completedTime: null,
            projectColor: task.projectColor || project?.color,
            projectClosed: task.projectClosed || project?.closed,
            projectViewMode: task.projectViewMode || project?.viewMode,
            projectKind: task.projectKind || project?.kind,
            projectPermission: task.projectPermission || project?.permission,
            parentId: task.parentId || null,
            items: task.items && Array.isArray(task.items) ? task.items.map((item: any) => {
                if (item.completedTime && typeof item.completedTime === "number") {
                    const dt = new Date(item.completedTime);
                    const y = dt.getFullYear();
                    const m = String(dt.getMonth() + 1).padStart(2, "0");
                    const d = String(dt.getDate()).padStart(2, "0");
                    const h = String(dt.getHours()).padStart(2, "0");
                    const min = String(dt.getMinutes()).padStart(2, "0");
                    const s = String(dt.getSeconds()).padStart(2, "0");
                    const offset = dt.getTimezoneOffset();
                    const oh = Math.abs(Math.floor(offset / 60));
                    const om = Math.abs(offset % 60);
                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                    return { ...item, completedTime: `${y}-${m}-${d}T${h}:${min}:${s}${tz}` };
                }
                return item;
            }) : []
        };
        this.plugin.settings.tasks.push(newTask);
        await this.plugin.saveSettings();
        return newTask;
    }

    async toggleTaskInDidaList(task: DidaTask) {
        if (task.didaId) {
            try {
                const projectId = task.projectId || "inbox";
                if (task.status !== 2) {
                    await this.updateTaskInDidaList(task);
                } else {
                    const res = await this.plugin.apiClient.makeAuthenticatedRequest(`https://api.dida365.com/open/v1/project/${projectId}/task/${task.didaId}/complete`, {
                        method: "POST"
                    } as any);
                    if (!res.ok) throw new Error("完成任务失败: " + res.status);
                }
            } catch (e) {
                throw e;
            }
        }
    }
}
