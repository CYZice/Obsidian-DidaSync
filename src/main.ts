import { Editor, EditorPosition, Modal, Notice, Plugin, TFile } from 'obsidian';
import { DidaApiClient } from './api/DidaApiClient';
import { RRuleParser } from './core/RRuleParser';
import { DailyNoteManager } from './managers/DailyNoteManager';
import { NativeTaskSyncManager } from './managers/NativeTaskSyncManager';
import { RepeatTaskManager } from './managers/RepeatTaskManager';
import { SyncManager } from './managers/SyncManager';
import { AddTaskToProjectModal } from './modals/AddTaskToProjectModal';
import { TaskSuggestionPopup } from './modals/TaskSuggestionPopup';
import { TimelineViewModal } from './modals/TimelineViewModal';
import { DidaSyncSettingTab } from './settings/DidaSyncSettingTab';
import { DEFAULT_SETTINGS, DidaSyncSettings, DidaTask } from './types';
import { DidaTimeBlockView, TIME_BLOCK_VIEW_TYPE } from './views/DidaTimeBlockView';
import { TaskActionMenu } from './views/TaskActionMenu';
import { TASK_VIEW_TYPE, TaskView } from './views/TaskView';

export default class DidaSyncPlugin extends Plugin {
    settings: DidaSyncSettings;
    apiClient: DidaApiClient;
    syncManager: SyncManager;
    nativeTaskSyncManager: NativeTaskSyncManager;
    repeatTaskManager: RepeatTaskManager;
    dailyNoteManager: DailyNoteManager;
    currentTaskActionMenu: TaskActionMenu | null = null;
    isTaskActionInProgress: boolean = false;
    isPluginActivated: boolean = false;
    syncIntervalId: number | null = null;
    debouncedEditorChange: (editor: Editor, info: any) => void;
    statusBarItem: HTMLElement | null = null;
    _cachedTaskLeaf: any = null;
    _handleOnlineForAutoSync: (() => void) | null = null;
    _handleOfflineForAutoSync: (() => void) | null = null;
    _nativeTaskSyncTimeouts: Map<string, number> | null = null;
    _isUpdatingNativeTaskStatus: boolean = false;
    _taskStatusChangeTimeout: number | null = null;
    _lastErrorTime: number | null = null;
    taskActionMenuDebounceTimer: number | null = null;
    dateChangeDebounceTimer: number | null = null;
    lastTaskMenuTriggerTime: number = 0;
    isReverseUpdating: boolean = false;

    async onload() {
        await this.loadSettings();
        document.documentElement.style.setProperty("--dida-hour-height", `${this.settings.timeBlockHourHeight || 80}px`);

        this.apiClient = new DidaApiClient(this);
        this.syncManager = new SyncManager(this);
        this.nativeTaskSyncManager = new NativeTaskSyncManager(this);
        this.repeatTaskManager = new RepeatTaskManager(this);
        this.dailyNoteManager = new DailyNoteManager(this.app, this);

        this.addSettingTab(new DidaSyncSettingTab(this.app, this));

        this.registerView(TASK_VIEW_TYPE, (leaf) => new TaskView(leaf, this));
        this.registerView(TIME_BLOCK_VIEW_TYPE, (leaf) => new DidaTimeBlockView(leaf, this));

        this.addRibbonIcon('check-square', 'Obsidian-DidaSync', () => {
            this.openTaskViewWithCache();
        });
        this.addRibbonIcon("calendar-check", "滴答时间线视图", () => {
            this.showTimelineView();
        });

        this.addCommand({
            id: 'open-dida-task-view',
            name: '打开滴答任务清单',
            callback: () => {
                this.openTaskViewWithCache();
            }
        });

        this.addCommand({
            id: 'sync-dida-tasks',
            name: '手动双向同步',
            callback: () => {
                this.manualSync();
            }
        });

        this.addCommand({
            id: 'create-task-in-project',
            name: '在项目中创建任务',
            callback: () => {
                this.showAddTaskToProjectModal();
            }
        });

        this.addCommand({
            id: 'show-timeline-view',
            name: '显示时间线日历视图',
            callback: () => {
                this.showTimelineView();
            }
        });

        this.addCommand({
            id: 'sync-daily-tasks',
            name: '同步今日任务到日记',
            callback: () => {
                this.dailyNoteManager.syncTodayTasksToActiveNote();
            }
        });

        this.addCommand({
            id: 'insert-create-dida-task',
            name: '插入/创建滴答任务',
            editorCallback: (editor: Editor) => {
                const cursor = editor.getCursor();
                this.showTaskSuggestions(editor, cursor);
            }
        });

        this.initializePluginFeatures();
    }

    async onunload() {
        this.clearAutoSync();
        try {
            if (this._handleOnlineForAutoSync) {
                window.removeEventListener("online", this._handleOnlineForAutoSync);
                this._handleOnlineForAutoSync = null;
            }
            if (this._handleOfflineForAutoSync) {
                window.removeEventListener("offline", this._handleOfflineForAutoSync);
                this._handleOfflineForAutoSync = null;
            }
        } catch (e) { }
        this._cachedTaskLeaf = null;
        if (this._taskStatusChangeTimeout) {
            clearTimeout(this._taskStatusChangeTimeout);
            this._taskStatusChangeTimeout = null;
        }
        this._lastErrorTime = null;
        const menus = document.querySelectorAll(".task-action-menu-inline");
        menus.forEach(m => m.remove());
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if (!this.settings.tasks) this.settings.tasks = [];
        this.settings.tasks.forEach(t => {
            if (t.content === undefined) t.content = "";
            if (t.desc === undefined) t.desc = "";
            if (t.items === undefined) t.items = [];
        });
        if (this.settings.autoCleanCompletedTasks === undefined) this.settings.autoCleanCompletedTasks = false;
        if (this.settings.autoCleanInterval === undefined) this.settings.autoCleanInterval = 1;
        if (this.settings.projectCollapsedStates === undefined) this.settings.projectCollapsedStates = {};
        await this.saveSettings();
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    createStatusBarItem() {
        if (!this.statusBarItem) {
            this.statusBarItem = this.addStatusBarItem();
            this.updateStatusBar("未连接");
            this.statusBarItem.addEventListener("click", () => {
                if (this.settings.accessToken) {
                    this.openTaskViewWithCache();
                } else {
                    this.apiClient.startOAuthFlow();
                }
            });
        }
    }

    updateStatusBar(text: string) {
        if (this.statusBarItem) {
            let displayText = text;
            try {
                if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) {
                    displayText = "离线中";
                }
            } catch (e) { }
            this.statusBarItem.setText(`滴答清单: ${displayText}`);
        }
    }

    setupAutoSync() {
        this.clearAutoSync();
        if (this.settings.autoSync && this.settings.accessToken) {
            try {
                if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) return;
            } catch (e) { }
            this.syncIntervalId = window.setInterval(() => {
                this.syncManager.syncFromDidaList();
            }, 60 * this.settings.syncInterval * 1000);
        }
    }

    clearAutoSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
    }

    async autoCleanCompletedTasks() {
        if (this.settings.autoCleanCompletedTasks) {
            const now = new Date();
            const months = this.settings.autoCleanInterval;
            const threshold = new Date(now);
            threshold.setMonth(threshold.getMonth() - months);
            const before = this.settings.tasks.filter(t => t.status === 2 && t.completedTime).filter(t => new Date(t.completedTime as string) < threshold);
            if (before.length > 0) {
                this.settings.tasks = this.settings.tasks.filter(t => t.status !== 2 || !t.completedTime || new Date(t.completedTime) >= threshold);
                await this.saveSettings();
                this.refreshTaskView();
            }
        }
    }

    async resetTaskData() {
        try {
            const count = this.settings.tasks.length;
            this.settings.tasks = [];
            await this.saveSettings();
            this.refreshTaskView();
            new Notice(`已清空 ${count} 个本地任务数据`);
            setTimeout(async () => {
                try {
                    new Notice("正在从滴答清单云端获取最新数据...");
                    await this.syncManager.syncFromDidaList();
                    const newCount = this.settings.tasks.length;
                    new Notice(`重置完成！已从云端获取 ${newCount} 个任务数据`);
                } catch (e) { }
            }, 1000);
        } catch (e) { }
    }

    initializePluginFeatures() {
        this.isPluginActivated = !!this.settings.accessToken;

        this.initializeMarkdownTaskLink();
        this.createStatusBarItem();
        this.setupAutoSync();

        this._handleOnlineForAutoSync = () => {
            try {
                if (this.settings.autoSync && this.settings.accessToken) {
                    this.setupAutoSync();
                    this.updateStatusBar("已连接");
                    this.refreshTaskView();
                    try {
                        this.safeManualSync();
                    } catch (e) { }
                }
            } catch (e) { }
        };
        this._handleOfflineForAutoSync = () => {
            try {
                this.clearAutoSync();
                this.updateStatusBar("离线中");
                this.refreshTaskView();
            } catch (e) { }
        };
        window.addEventListener("online", this._handleOnlineForAutoSync);
        window.addEventListener("offline", this._handleOfflineForAutoSync);

        this.registerEvent(this.app.workspace.on("layout-change", () => {
            if (this._cachedTaskLeaf && this._cachedTaskLeaf.isDestroyed) this._cachedTaskLeaf = null;
        }));

        this.registerEvent(this.app.vault.on("modify", async (file) => {
            if (!this._isUpdatingNativeTaskStatus && this.settings.enableNativeTaskSync && file.extension === "md") {
                const path = file.path;
                if (!this._nativeTaskSyncTimeouts) this._nativeTaskSyncTimeouts = new Map();
                if (this._nativeTaskSyncTimeouts.has(path)) {
                    clearTimeout(this._nativeTaskSyncTimeouts.get(path)!);
                }
                const timeoutId = window.setTimeout(async () => {
                    this._nativeTaskSyncTimeouts!.delete(path);
                    if (this._isUpdatingNativeTaskStatus) return;
                    try {
                        const content = await this.app.vault.read(file);
                        const nativeTasks = this.nativeTaskSyncManager.detectNativeTasks(content, file.path);
                        let changed = false;
                        for (const nativeTask of nativeTasks) {
                            if (nativeTask.hasLink && nativeTask.didaId) {
                                const task = this.settings.tasks.find(t => t.didaId === nativeTask.didaId);
                                if (task) {
                                    const newStatus = nativeTask.isCompleted ? 2 : 0;
                                    if (task.status !== newStatus) {
                                        if (newStatus === 2 && RRuleParser.hasRepeatRule(task)) {
                                            const idx = this.settings.tasks.findIndex(t => t.didaId === task.didaId);
                                            if (idx !== -1) {
                                                try {
                                                    this._isUpdatingNativeTaskStatus = true;
                                                    await this.toggleTask(idx);
                                                    changed = true;
                                                } catch (e) {
                                                    this.updateTaskStatusDirectly(task, newStatus);
                                                    changed = true;
                                                } finally {
                                                    this._isUpdatingNativeTaskStatus = false;
                                                }
                                            }
                                        } else {
                                            this.updateTaskStatusDirectly(task, newStatus);
                                            changed = true;
                                            if (this.settings.accessToken) {
                                                setTimeout(async () => {
                                                    try {
                                                        await this.toggleTaskInDidaList(task);
                                                    } catch (e) { }
                                                }, 0);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (changed) {
                            await this.saveSettings();
                            this.refreshTaskView();
                        }
                    } catch (e) {
                        if (!this._lastErrorTime || Date.now() - this._lastErrorTime > 30000) {
                            this._lastErrorTime = Date.now();
                        }
                    }
                }, 2000);
                this._nativeTaskSyncTimeouts.set(path, timeoutId);
            }
        }));

        if (this.settings.accessToken) {
            setTimeout(async () => {
                try {
                    await this.safeManualSync();
                } catch (e) { }
            }, 2000);
        }
        if (this.settings.autoCleanCompletedTasks) {
            setTimeout(async () => {
                try {
                    await this.autoCleanCompletedTasks();
                } catch (e) { }
            }, 30000);
        }
    }

    async checkPluginStatusAndNotify(): Promise<boolean> {
        if (!this.settings.accessToken) {
            new Notice("请先在设置中配置Dida Sync插件");
            return false;
        }
        return true;
    }

    async manualSync() {
        if (await this.checkPluginStatusAndNotify()) {
            try {
                this.updateStatusBar("双向同步中...");
                await this.syncManager.syncToDidaList();
                await this.syncManager.syncFromDidaList();
            } catch (e) { }
        }
    }

    async safeManualSync() {
        if (await this.checkPluginStatusAndNotify()) {
            try {
                this.updateStatusBar("双向同步中...");
                await this.syncManager.syncNewTasksToDidaList();
                await new Promise(resolve => setTimeout(resolve, 1000));
                await this.syncManager.syncFromDidaList();
            } catch (e) { }
        }
    }

    // Proxy methods to SyncManager
    async syncFromDidaList() {
        await this.syncManager.syncFromDidaList();
    }

    async syncToDidaList() {
        await this.syncManager.syncToDidaList();
    }

    async syncNewTasksToDidaList() {
        await this.syncManager.syncNewTasksToDidaList();
    }

    async createTaskInDidaList(task: DidaTask) {
        return this.syncManager.createTaskInDidaList(task);
    }

    async updateTaskInDidaList(task: DidaTask) {
        return this.syncManager.updateTaskInDidaList(task);
    }

    async deleteTaskInDidaList(task: DidaTask) {
        return this.syncManager.deleteTaskInDidaList(task.didaId as string, task.projectId || "inbox");
    }

    async toggleTaskInDidaList(task: DidaTask) {
        return this.syncManager.toggleTaskInDidaList(task);
    }

    async syncTaskToDidaListInBackground(task: DidaTask) {
        if (this.settings.accessToken && task.didaId) {
            try {
                await this.updateTaskInDidaList(task);
            } catch (e) { }
        }
    }

    // View Management
    async openTaskViewWithCache() {
        const workspace = this.app.workspace;
        if (this._cachedTaskLeaf && !this._cachedTaskLeaf.isDestroyed) {
            workspace.revealLeaf(this._cachedTaskLeaf);
        } else {
            let leaf = null;
            const leaves = workspace.getLeavesOfType(TASK_VIEW_TYPE);
            if (leaves.length > 0) {
                leaf = leaves[0];
            } else {
                leaf = workspace.getRightLeaf(false);
                if (leaf) {
                    await leaf.setViewState({ type: TASK_VIEW_TYPE, active: true });
                }
            }
            if (leaf) {
                this._cachedTaskLeaf = leaf;
                workspace.revealLeaf(leaf);
                this.registerEvent(leaf.on("close", () => {
                    if (this._cachedTaskLeaf === leaf) this._cachedTaskLeaf = null;
                }));
            }
        }
        if (this.settings.accessToken) {
            await this.syncManager.syncFromDidaList();
        }
    }

    refreshTaskView() {
        const leaves = this.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
        leaves.forEach(leaf => {
            if (leaf.view instanceof TaskView) {
                leaf.view.renderTaskList();
            }
        });

        // Also refresh timeline view if open (it's a modal, handled internally or via re-render)
    }

    showTimelineView() {
        if (this.isPluginActivated) {
            try {
                if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) {
                    new Notice("当前处于离线状态，时间线视图不可用");
                    return;
                }
            } catch (e) { }
            new TimelineViewModal(this.app, this).open();
        } else {
            this.checkPluginStatusAndNotify();
        }
    }

    showAddTaskToProjectModal(projectName?: string, projectId?: string, target?: HTMLElement) {
        if (this.isPluginActivated) {
            const modal = new AddTaskToProjectModal(this.app, this);
            modal.open();
        } else {
            this.checkPluginStatusAndNotify();
        }
    }

    // Task Management
    async addTask(title: string, projectName: string = "收集箱", projectId: string = "inbox", shouldSync: boolean = true, dueDate: string | null = null): Promise<DidaTask> {
        const newTask: DidaTask = {
            id: Date.now().toString(),
            title: title,
            content: "",
            completed: false,
            status: 0,
            didaId: null,
            projectId: projectId,
            projectName: projectName,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            items: [],
            dueDate: dueDate || undefined,
            kind: "TEXT",
            priority: 0,
            sortOrder: 0,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            isFloating: false,
            isAllDay: false
        };

        this.settings.tasks = this.settings.tasks || [];
        this.settings.tasks.push(newTask);
        await this.saveSettings();
        this.refreshTaskView();

        if (shouldSync && this.settings.accessToken) {
            try {
                await this.createTaskInDidaList(newTask);
                this.refreshTaskView();
            } catch (e) {
                this.refreshTaskView();
            }
        }

        return newTask;
    }

    async updateTaskContent(index: number, content: string) {
        if (this.settings.tasks && !(index >= this.settings.tasks.length)) {
            const task = this.settings.tasks[index];
            task.content = content;
            task.updatedAt = new Date().toISOString();
            await this.saveSettings();
            if (this.settings.accessToken && task.didaId) {
                setTimeout(() => {
                    this.updateTaskContentInDidaList(task).catch(() => { });
                }, 0);
            }
        }
    }

    async updateTaskContentInDidaList(task: DidaTask) {
        if (task.didaId) {
            const payload: any = {
                id: task.didaId,
                title: task.title,
                content: task.content || "",
                desc: task.desc || "",
                status: task.status
            };
            if (task.items && Array.isArray(task.items) && task.items.length > 0) {
                const content = task.content || task.desc || "";
                payload.content = content;
                payload.desc = content;
            }
            if (task.projectId && task.projectId !== "inbox") payload.projectId = task.projectId;
            if (task.dueDate !== undefined) {
                if (task.dueDate === null) payload.dueDate = null;
                else if (task.dueDate.endsWith("Z")) payload.dueDate = task.dueDate.replace("Z", "+0000");
                else payload.dueDate = task.dueDate;
            }
            if (task.startDate) payload.startDate = task.startDate;
            if (task.isAllDay !== undefined) payload.isAllDay = task.isAllDay;
            if (task.parentId) payload.parentId = task.parentId;
            if (task.items && Array.isArray(task.items)) payload.items = task.items;
            if (typeof task.repeatFlag === "string") {
                const rf = task.repeatFlag.trim();
                payload.repeatFlag = rf === "" ? "" : rf;
            }
            try {
                const res = await this.apiClient.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task/" + task.didaId, {
                    method: "POST",
                    body: JSON.stringify(payload)
                } as any);
                if (!res.ok) {
                    await res.text();
                    throw new Error("更新任务失败: " + res.status);
                }
                task.updatedAt = new Date().toISOString();
                await this.saveSettings();
            } catch (e) {
                throw e;
            }
        }
    }

    async toggleTask(index: number) {
        const task = this.settings.tasks[index];
        if (task) {
            if (task.status === 2) {
                task.status = 0;
                task.completedTime = null;
                task.completed = false;
            } else {
                task.status = 2;
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
                task.completedTime = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                task.completed = true;

                if (RRuleParser.hasRepeatRule(task) && this.repeatTaskManager) {
                    try {
                        await this.repeatTaskManager.createRepeatTaskCopy(task);
                    } catch (e) { }
                }
            }

            task.updatedAt = new Date().toISOString();

            if (task.status === 2 && task.didaId) {
                for (const sub of this.settings.tasks.filter(t => t.parentId === task.didaId)) {
                    if (sub.status !== 2) {
                        sub.status = 2;
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
                        sub.completedTime = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                        sub.updatedAt = new Date().toISOString();
                        if (this.settings.accessToken && sub.didaId) {
                            setTimeout(() => {
                                this.toggleTaskInDidaList(sub).catch(() => { });
                            }, 0);
                        }
                    }
                }
            }

            await this.saveSettings();
            if (this.settings.accessToken && task.didaId) {
                setTimeout(() => {
                    this.toggleTaskInDidaList(task).catch(() => { });
                }, 0);
            }
            this.refreshTaskView();
            if (task.didaId) {
                setTimeout(() => {
                    const leaves = this.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
                    if (leaves.length > 0) {
                        const view = leaves[0].view as TaskView;
                        if (view && (view as any).updateNativeTaskStatus) {
                            (view as any).updateNativeTaskStatus(task, task.status === 2).catch(() => { });
                        }
                    }
                }, 500);
            }
        }
    }

    async deleteTask(index: number) {
        const task = this.settings.tasks[index];
        if (task) {
            this.settings.tasks.splice(index, 1);
            await this.saveSettings();
            this.refreshTaskView();

            if (this.settings.accessToken && task.didaId) {
                this.deleteTaskInDidaList(task).catch(console.error);
            }
        }
    }

    // Native Task Sync & Editor Integration
    initializeMarkdownTaskLink() {
        this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
            this.handleEditorChange(editor, info);
        }));
        this.registerEvent(this.app.workspace.on("click", (evt) => {
            this.handleTaskLinkClick(evt as MouseEvent);
        }));
        this.registerEvent(this.app.workspace.on("file-open", () => {
            this.setupDidaLinkHandler();
        }));
        this.setupDidaLinkHandler();
        this.registerObsidianProtocolHandler("dida-task", (params) => {
            let didaId: string | null = null;
            if (params.didaId) didaId = params.didaId;
            else if ((params as any).action) didaId = (params as any).action.split("/")[1];
            else if (typeof params === "string") didaId = (params as any).split("/").pop();
            if (didaId) this.openTaskDetails(didaId);
        });
    }

    handleEditorChange(editor: Editor, info: any) {
        try {
            if (editor && editor.getCursor && editor.getLine && !this._isUpdatingNativeTaskStatus) {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const prefix = line.substring(0, cursor.ch);
                if (prefix.endsWith("@@")) {
                    setTimeout(() => {
                        this.showTaskSuggestions(editor, cursor);
                    }, 10);
                }
                if (this.settings.enableNativeTaskSync) {
                    const completedMatch = line.match(/^(\s*)-\s\[x\]\s.*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-f0-9]+)\)/i);
                    const incompleteMatch = line.match(/^(\s*)-\s\[\s\]\s.*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-f0-9]+)\)/);
                    if (completedMatch || incompleteMatch) {
                        const didaId = (completedMatch || incompleteMatch)![2];
                        const isCompleted = !!completedMatch;
                        const task = this.settings.tasks.find(t => t.didaId === didaId);
                        if (task) {
                            const status = isCompleted ? 2 : 0;
                            if (task.status !== status) {
                                if (this._taskStatusChangeTimeout) {
                                    clearTimeout(this._taskStatusChangeTimeout);
                                    this._taskStatusChangeTimeout = null;
                                }
                                this._taskStatusChangeTimeout = window.setTimeout(async () => {
                                    try {
                                        this._isUpdatingNativeTaskStatus = true;
                                        if (status === 2 && RRuleParser.hasRepeatRule(task)) {
                                            const idx = this.settings.tasks.findIndex(t => t.didaId === didaId);
                                            if (idx !== -1) await this.toggleTask(idx);
                                        } else {
                                            this.updateTaskStatusDirectly(task, status);
                                            await this.saveSettings();
                                            this.refreshTaskView();
                                            if (this.settings.accessToken) {
                                                setTimeout(async () => {
                                                    try {
                                                        await this.toggleTaskInDidaList(task);
                                                    } catch (e) { }
                                                }, 0);
                                            }
                                        }
                                    } catch (e) { }
                                    finally {
                                        this._isUpdatingNativeTaskStatus = false;
                                        this._taskStatusChangeTimeout = null;
                                    }
                                }, 300);
                            }
                        }
                    }
                    if (this.taskActionMenuDebounceTimer) {
                        clearTimeout(this.taskActionMenuDebounceTimer);
                        this.taskActionMenuDebounceTimer = null;
                    }
                    if (prefix.match(/^(\s*)-\s\[\s\]\s(.*)$/)) {
                        if (this.isTaskActionInProgress) return;
                        if (this.currentTaskActionMenu && this.currentTaskActionMenu.isOpen && this.currentTaskActionMenu.isSamePosition(editor, cursor)) return;
                        if (Date.now() - this.lastTaskMenuTriggerTime < 300) return;
                        this.taskActionMenuDebounceTimer = window.setTimeout(() => {
                            this.lastTaskMenuTriggerTime = Date.now();
                            this.showTaskActionMenu(editor, cursor);
                            this.taskActionMenuDebounceTimer = null;
                        }, 150);
                    } else if (this.currentTaskActionMenu && this.currentTaskActionMenu.isOpen) {
                        this.currentTaskActionMenu.close();
                        this.currentTaskActionMenu = null;
                    }
                }
                if (this.dateChangeDebounceTimer) {
                    clearTimeout(this.dateChangeDebounceTimer);
                    this.dateChangeDebounceTimer = null;
                }
                const dateRegex = /^(\s*)-\s\[\s\]\s*(.+)📅\s*(\d{4}-\d{2}-\d{2})(.*)$/;
                const match = line.match(dateRegex);
                if (match) {
                    const title = match[2].trim();
                    const dateStr = match[3];
                    const linkMatch = line.match(/\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-f0-9]+)\)/);
                    if (linkMatch) {
                        const didaId = linkMatch[1];
                        if (!this.isTaskActionInProgress) {
                            this.dateChangeDebounceTimer = window.setTimeout(() => {
                                this.handleDateChange(didaId, dateStr, title);
                                this.dateChangeDebounceTimer = null;
                            }, 500);
                        }
                    }
                }
            }
        } catch (e) { }
    }

    showTaskSuggestions(editor: Editor, cursor: EditorPosition, onSelect?: (task: DidaTask) => void) {
        try {
            let activeView: any;
            const popup = new TaskSuggestionPopup(this.app, this, editor, cursor, (task) => {
                if (onSelect) {
                    onSelect(task);
                } else {
                    this.insertTaskLink(editor, cursor, task);
                }
            });
            const el = popup.element!;
            el.style.position = "fixed";
            el.style.width = "400px";
            el.style.maxHeight = "300px";
            el.style.overflowY = "auto";
            el.style.zIndex = "1000";
            el.style.backgroundColor = "var(--background-primary)";
            el.style.border = "1px solid var(--background-modifier-border)";
            el.style.borderRadius = "8px";
            el.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.15)";
            el.style.padding = "16px";

            let editorDom: HTMLElement | null = null;
            if ((editor as any).cm && (editor as any).cm.dom) editorDom = (editor as any).cm.dom;
            else if ((editor as any).getInputField && typeof (editor as any).getInputField === "function") editorDom = (editor as any).getInputField();
            else if ((editor as any).dom) editorDom = (editor as any).dom;
            else {
                activeView = this.app.workspace.getActiveViewOfType("markdown");
                if (activeView && activeView.editor) editorDom = activeView.editor.cm?.dom || activeView.editor.dom;
            }

            let lineEl: HTMLElement | null = null;
            let fallbackTop = 100;
            let fallbackLeft = 10;

            if (editorDom) {
                const rect = editorDom.getBoundingClientRect();
                let top = rect.top;
                let left = rect.left;
                if ((editor as any).cm && (editor as any).cm.cursorCoords) {
                    try {
                        const coords = (editor as any).cm.cursorCoords(cursor, "page");
                        top = coords.top;
                        left = coords.left;
                    } catch (e) {
                        top = rect.top + 20 * cursor.line + 20;
                        left = rect.left + 20;
                    }
                } else {
                    top = rect.top + 20 * cursor.line + 20;
                    left = rect.left + 20;
                }
                fallbackTop = top;
                fallbackLeft = left;

                if ((editor as any).cm && (editor as any).cm.dom) {
                    try {
                        const lines = (editor as any).cm.dom.querySelectorAll(".cm-line");
                        const currentLine = editor.getLine(cursor.line);
                        let idx = -1;
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].textContent.trim() === currentLine.trim()) {
                                idx = i;
                                break;
                            }
                        }
                        if (idx === -1) {
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].textContent.includes("@@")) {
                                    idx = i;
                                    break;
                                }
                            }
                        }
                        if (idx === -1) {
                            const targetLine = cursor.line;
                            let closest = -1;
                            let dist = Infinity;
                            for (let i = 0; i < lines.length; i++) {
                                const offsetTop = (lines[i] as HTMLElement).offsetTop;
                                const approxLine = Math.round(offsetTop / 32);
                                const diff = Math.abs(approxLine - targetLine);
                                if (diff < dist) {
                                    dist = diff;
                                    closest = i;
                                }
                            }
                            if (closest !== -1) idx = closest;
                        }
                        lineEl = idx >= 0 ? lines[idx] : (lines.length > 0 ? lines[0] : null);
                    } catch (e) { }
                }

                if (lineEl) {
                    const lineRect = lineEl.getBoundingClientRect();
                    el.style.left = lineRect.left + "px";
                    el.style.top = lineRect.bottom + 5 + "px";
                } else {
                    el.style.left = rect.left + "px";
                    el.style.top = rect.bottom + 5 + "px";
                }
                const popupRect = el.getBoundingClientRect();
                const winHeight = window.innerHeight;
                const winWidth = window.innerWidth;
                if (popupRect.bottom > winHeight) {
                    if (lineEl) {
                        const lineRect = lineEl.getBoundingClientRect();
                        const newTop = lineRect.top - popupRect.height - 5;
                        el.style.top = Math.max(10, newTop) + "px";
                    } else {
                        const newTop = top - popupRect.height - 5;
                        el.style.top = Math.max(10, newTop) + "px";
                    }
                }
                if (popupRect.right > winWidth) el.style.left = winWidth - popupRect.width - 10 + "px";
                if (popupRect.left < 10) el.style.left = "10px";
            } else {
                el.style.left = fallbackLeft + "px";
                el.style.top = fallbackTop + "px";
            }
        } catch (e) { }
    }

    insertTaskLink(editor: Editor, cursor: EditorPosition, task: DidaTask) {
        const line = editor.getLine(cursor.line);
        let before = line.substring(0, cursor.ch);

        // Check if triggered by @@
        if (before.endsWith("@@")) {
            before = before.substring(0, cursor.ch - 2);
        }

        const after = line.substring(cursor.ch);
        const linkText = `[@@${task.title || "无标题任务"}](obsidian://dida-task?didaId=${task.didaId})`;
        editor.setLine(cursor.line, before + linkText + after);
        editor.setCursor({ line: cursor.line, ch: before.length + linkText.length });
    }

    linkTaskToLine(editor: Editor, cursor: EditorPosition, task: DidaTask) {
        const line = editor.getLine(cursor.line);
        const linkRegex = /\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[^)]+\)/;
        const newLink = `[🔗Dida](obsidian://dida-task?didaId=${task.didaId})`;

        if (linkRegex.test(line)) {
            const newLine = line.replace(linkRegex, newLink);
            editor.setLine(cursor.line, newLine);
        } else {
            const match = line.match(/^(\s*)-\s\[[ x]\]\s*(.*)$/);
            if (match) {
                const content = match[2].trim();
                if (!content) {
                    const newLine = `${match[1]}- [ ] ${task.title} ${newLink}`;
                    editor.setLine(cursor.line, newLine);
                } else {
                    const newLine = line.trimEnd() + " " + newLink;
                    editor.setLine(cursor.line, newLine);
                }
            } else {
                const newLine = line.trimEnd() + " " + newLink;
                editor.setLine(cursor.line, newLine);
            }
        }
    }

    showTaskActionMenu(editor: Editor, cursor: EditorPosition) {
        try {
            if (!this.settings.enableNativeTaskSync) return;
            if (this.currentTaskActionMenu && this.currentTaskActionMenu.isOpen && this.currentTaskActionMenu.isSamePosition(editor, cursor)) return;
            if (this.currentTaskActionMenu) {
                this.currentTaskActionMenu.close();
                this.currentTaskActionMenu = null;
            }
            const menu = new TaskActionMenu(this.app, this, editor, cursor, (action, data) => {
                this.handleTaskAction(editor, cursor, action, data);
            });
            this.currentTaskActionMenu = menu;
            menu.open();
        } catch (e) { }
    }

    async handleTaskAction(editor: Editor, cursor: EditorPosition, action: string, data: any) {
        try {
            this.isTaskActionInProgress = true;
            const line = editor.getLine(cursor.line);
            if (action === "sync") {
                await this.syncTaskToDidaList(editor, cursor, line);
            } else if (action === "date") {
                this.addDateToTask(editor, cursor, line, data.date);
            } else if (action === "search") {
                this.showTaskSuggestions(editor, cursor, (task) => {
                    this.linkTaskToLine(editor, cursor, task);
                });
            } else if (action === "selectTask") {
                if (data && data.task) {
                    this.linkTaskToLine(editor, cursor, data.task);
                }
            }
            setTimeout(() => {
                this.isTaskActionInProgress = false;
            }, 500);
        } catch (e) {
            setTimeout(() => {
                this.isTaskActionInProgress = false;
            }, 100);
        }
    }

    async syncTaskToDidaList(editor: Editor, cursor: EditorPosition, line: string) {
        try {
            if (this.settings.accessToken) {
                const match = line.match(/^(\s*)-\s\[\s\]\s*(.+)$/);
                if (match) {
                    const indent = match[1];
                    let content = match[2].trim();
                    if (content) {
                        const linkRegex = /\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([^)]+)\)/;
                        const linkMatch = content.match(linkRegex);
                        if (linkMatch) {
                            new Notice("ℹ️ 任务已同步，无需再次同步", 3000);
                        } else {
                            let title = content;
                            title = title.replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "").trim();
                            title = title.replace(/\[🔗[^\]]*\]\([^)]*\)/g, "").trim();
                            title = title.replace(/\[[^\]]*\]\([^)]*\)/g, "").trim();
                            title = title.replace(/\s+/g, " ").trim();
                            if (title) {
                                const created = await this.createTaskDirectly(title);
                                if (created && created.id) {
                                    const newLine = indent + `- [ ] ${content} [🔗Dida](${`obsidian://dida-task?didaId=${created.id}`}) `;
                                    editor.setLine(cursor.line, newLine);
                                    const task: DidaTask = {
                                        id: Date.now().toString(),
                                        title: title,
                                        content: "",
                                        completed: false,
                                        status: 0,
                                        didaId: created.id,
                                        projectId: created.projectId || "inbox",
                                        projectName: "收集箱",
                                        createdAt: new Date().toISOString(),
                                        updatedAt: new Date().toISOString(),
                                        items: [],
                                        dueDate: null as any,
                                        etag: created.etag || "",
                                        completedTime: null,
                                        startDate: null as any,
                                        isAllDay: false,
                                        kind: "TEXT",
                                        projectViewMode: "list",
                                        projectKind: "TASK",
                                        reminders: [],
                                        repeatFlag: null as any,
                                        desc: "",
                                        projectColor: "#F18181",
                                        projectClosed: false,
                                        projectPermission: "write",
                                        parentId: null
                                    };
                                    this.settings.tasks.push(task);
                                    await this.saveSettings();
                                    new Notice("✅ 任务已同步到滴答清单", 3000);
                                    this.refreshTaskView();
                                } else {
                                    new Notice("❌ 同步失败，请重试");
                                }
                            }
                        }
                    } else {
                        new Notice("❌ 任务内容不能为空");
                    }
                } else {
                    new Notice("❌ 无法识别任务格式");
                }
            } else {
                new Notice("❌ 请先进行OAuth认证");
            }
        } catch (e: any) {
            let msg = "同步失败";
            if (e.message?.includes("401")) msg = "未经授权";
            else if (e.message?.includes("403")) msg = "禁止访问";
            else if (e.message?.includes("404")) msg = "未找到";
            else if (e.message) msg = "同步失败: " + e.message;
            new Notice("❌ " + msg, 5000);
        }
    }

    async createTaskDirectly(title: string) {
        const data = {
            title: title,
            content: "",
            desc: ""
        };
        try {
            const res = await this.apiClient.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(data)
            } as any);
            if (res.ok) return await res.json();
            const errText = await res.text();
            throw new Error(`API调用失败: ${res.status} - ${errText}`);
        } catch (e) {
            throw e;
        }
    }

    async addDateToTask(editor: Editor, cursor: EditorPosition, line: string, date: string) {
        try {
            const match = line.match(/^(\s*)-\s\[\s\]\s*(.+)$/);
            if (match) {
                const indent = match[1];
                const content = match[2].trim();
                const dateRegex = /📅\s*\d{4}-\d{2}-\d{2}/;
                const hasDate = dateRegex.test(content);
                const linkRegex = /\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([^)]+)\)/;
                const linkMatch = content.match(linkRegex);
                if (linkMatch) {
                    const newLine = hasDate ? indent + "- [ ] " + content.replace(dateRegex, `📅 ${date} `) : indent + `- [ ] ${content} 📅 ${date} `;
                    editor.setLine(cursor.line, newLine);
                    const didaId = linkMatch[1];
                    const task = this.settings.tasks.find(t => t.didaId === didaId);
                    if (task) {
                        const baseDate = date.includes("T") ? date : (() => {
                            const now = new Date();
                            const parts = date.split("-");
                            const y = parseInt(parts[0]);
                            const m = parseInt(parts[1]) - 1;
                            const d = parseInt(parts[2]);
                            return new Date(y, m, d, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
                        })();
                        if (task.startDate && task.dueDate && task.startDate !== task.dueDate) {
                            const parts = date.split("-");
                            const y = parseInt(parts[0]);
                            const m = parseInt(parts[1]) - 1;
                            const d = parseInt(parts[2]);
                            const adjust = (t: string) => {
                                try {
                                    const dt = new Date(t);
                                    if (isNaN(dt.getTime())) return baseDate;
                                    return new Date(y, m, d, dt.getHours(), dt.getMinutes(), dt.getSeconds()).toISOString();
                                } catch (e) {
                                    return baseDate;
                                }
                            };
                            task.startDate = adjust(task.startDate);
                            task.dueDate = adjust(task.dueDate);
                        } else {
                            task.dueDate = baseDate;
                            task.startDate = baseDate;
                            task.isAllDay = true;
                        }
                        task.updatedAt = new Date().toISOString();
                        await this.saveSettings();
                        await this.updateTaskInDidaList(task);
                        this.refreshTaskView();
                    }
                } else {
                    new Notice("请先同步到滴答清单，再设置到期日期");
                }
            } else {
                new Notice("无法识别任务格式");
            }
        } catch (e: any) {
            let msg = "添加日期失败";
            if (e.message?.includes("401")) msg = "未经授权";
            else if (e.message?.includes("403")) msg = "禁止连接";
            else if (e.message?.includes("404")) msg = "未找到";
            else if (e.message) msg = "添加日期失败: " + e.message;
            new Notice("❌ " + msg);
        }
    }

    async handleDateChange(didaId: string, newDate: string, newTitle?: string) {
        try {
            const task = this.settings.tasks.find(t => t.didaId === didaId);
            if (task) {
                let baseDate = newDate.includes("T") ? newDate : (() => {
                    const now = new Date();
                    const parts = newDate.split("-");
                    const y = parseInt(parts[0]);
                    const m = parseInt(parts[1]) - 1;
                    const d = parseInt(parts[2]);
                    return new Date(y, m, d, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
                })();
                if (task.startDate && task.dueDate && task.startDate !== task.dueDate) {
                    const parts = newDate.split("-");
                    const y = parseInt(parts[0]);
                    const m = parseInt(parts[1]) - 1;
                    const d = parseInt(parts[2]);
                    const adjust = (t: string) => {
                        try {
                            const dt = new Date(t);
                            if (isNaN(dt.getTime())) return baseDate;
                            return new Date(y, m, d, dt.getHours(), dt.getMinutes(), dt.getSeconds()).toISOString();
                        } catch (e) {
                            return baseDate;
                        }
                    };
                    const start = adjust(task.startDate);
                    const due = adjust(task.dueDate);
                    if (task.startDate === start && task.dueDate === due) return;
                    task.startDate = start;
                    task.dueDate = due;
                } else {
                    if (task.dueDate === baseDate && task.startDate === baseDate) return;
                    task.dueDate = baseDate;
                    task.startDate = baseDate;
                    task.isAllDay = true;
                }
                if (newTitle) {
                    let cleanTitle = newTitle;
                    // 去除 [🔗Dida](obsidian://...) 链接
                    cleanTitle = cleanTitle.replace(/\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-zA-Z0-9]+\)\s*/g, "").trim();
                    // 去除 📅 日期后缀（防万一）
                    cleanTitle = cleanTitle.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*/g, "").trim();
                    cleanTitle = cleanTitle.replace(/\s+/g, " ").trim();
                    task.title = cleanTitle;
                }
                task.updatedAt = new Date().toISOString();
                await this.saveSettings();
                await this.updateTaskInDidaList(task);
                this.refreshTaskView();
            }
        } catch (e: any) {
            let msg = "同步日期变更失败";
            if (e.message?.includes("401")) msg = "未经授权";
            else if (e.message?.includes("403")) msg = "禁止连接";
            else if (e.message?.includes("404")) msg = "未找到";
            else if (e.message) msg = "同步日期变更失败: " + e.message;
            new Notice("❌ " + msg);
        }
    }

    async handleTitleChange(didaId: string, newTitle: string) {
        try {
            const task = this.settings.tasks.find(t => t.didaId === didaId);
            if (task && task.title !== newTitle) {
                task.title = newTitle;
                task.updatedAt = new Date().toISOString();
                await this.saveSettings();
                await this.updateTaskInDidaList(task);
                this.refreshTaskView();
                new Notice("✅ 已同步标题变更到滴答清单");
            }
        } catch (e: any) {
            let msg = "同步标题变更失败";
            if (e.message?.includes("401")) msg = "未经授权";
            else if (e.message?.includes("403")) msg = "禁止连接";
            else if (e.message?.includes("404")) msg = "未找到";
            else if (e.message) msg = "同步标题变更失败: " + e.message;
            new Notice("❌ " + msg);
        }
    }

    handleTaskLinkClick(evt: MouseEvent) {
        const target = evt.target as HTMLElement;
        if (target.tagName === "A" && (target as HTMLAnchorElement).href && (target as HTMLAnchorElement).href.includes("obsidian://dida-task/")) {
            const didaId = (target as HTMLAnchorElement).href.split("obsidian://dida-task/")[1];
            this.openTaskDetails(didaId);
            evt.preventDefault();
            evt.stopPropagation();
        } else {
            let el: HTMLElement | null = target;
            while (el && el !== document.body) {
                const match = (el.textContent || el.innerText || "").match(/@@([a-zA-Z0-9]+)/);
                if (match) {
                    const didaId = match[1];
                    this.openTaskDetails(didaId);
                    evt.preventDefault();
                    evt.stopPropagation();
                    return;
                }
                el = el.parentElement;
            }
        }
    }

    // File Operations
    async findFilesWithDidaId(didaId: string): Promise<TFile[]> {
        const files: TFile[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            try {
                const content = await this.app.vault.read(file);
                const escaped = didaId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const regex = new RegExp(`\\[[^\\]]*\\]\\(obsidian://dida-task\\?didaId=${escaped}\\)`, "g");
                if (regex.test(content)) files.push(file);
            } catch (e) { }
        }
        return files;
    }

    async jumpToDidaIdInFile(didaId: string, button: HTMLElement | null = null) {
        const files = await this.findFilesWithDidaId(didaId);
        if (files.length === 0) return;
        if (files.length === 1) {
            await this.openFileAndLocateDidaId(files[0], didaId);
        } else {
            if (button) this.showFileSelectionDropdown(files, didaId, button);
            else this.showFileSelectionModal(files, didaId);
        }
    }

    async openFileAndLocateDidaId(file: TFile, didaId: string) {
        try {
            let targetLeaf: any = null;
            for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
                if (leaf.view && leaf.view.file && leaf.view.file.path === file.path) {
                    targetLeaf = leaf;
                    break;
                }
            }
            if (targetLeaf) this.app.workspace.setActiveLeaf(targetLeaf);
            else targetLeaf = await this.app.workspace.openLinkText(file.path, "", true);
            setTimeout(async () => {
                const view = targetLeaf.view;
                if (view && view.editor) {
                    const content = view.editor.getValue();
                    const lines = content.split("\n");
                    let foundLine = -1;
                    let indent = 0;
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const match = line.match(/^(\s*)-\s*\[([ x])\]\s*(.+)/);
                        if (match) {
                            const escaped = didaId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                            if (new RegExp(`\\[[^\\]]*\\]\\(obsidian://dida-task\\?didaId=${escaped}\\)`).test(line)) {
                                foundLine = i;
                                indent = match[1].length;
                                break;
                            }
                        }
                    }
                    if (foundLine !== -1) {
                        const cursor = { line: foundLine, ch: indent };
                        view.editor.setCursor(cursor);
                        view.editor.scrollIntoView(cursor, true);
                        const len = lines[foundLine].length;
                        if (view.editor.addHighlights) {
                            view.editor.addHighlights([{ line: foundLine, from: 0, to: len }]);
                            setTimeout(() => {
                                if (view.editor.removeHighlights) view.editor.removeHighlights();
                            }, 3000);
                        }
                    } else {
                        const escaped = didaId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                        const match = new RegExp(`\\[[^\\]]*\\]\\(obsidian://dida-task\\?didaId=${escaped}\\)`, "g").exec(content);
                        if (match) {
                            const pos = match.index;
                            const before = content.substring(0, pos).split("\n");
                            const line = before.length - 1;
                            const ch = before[before.length - 1].length;
                            view.editor.setCursor({ line, ch });
                            view.editor.scrollIntoView({ line, ch }, true);
                        }
                    }
                }
            }, 100);
        } catch (e) { }
    }

    showFileSelectionDropdown(files: TFile[], didaId: string, button: HTMLElement) {
        const dropdown = document.createElement("div");
        dropdown.className = "dida-file-dropdown";
        const list = dropdown.createDiv("dida-file-list");
        files.forEach(file => {
            const item = list.createDiv("dida-file-item");
            item.createEl("span", { text: file.basename, cls: "dida-file-name" });
            item.createEl("span", { text: file.path, cls: "dida-file-path" });
            item.onclick = async () => {
                dropdown.remove();
                await this.openFileAndLocateDidaId(file, didaId);
            };
        });
        const rect = button.getBoundingClientRect();
        dropdown.style.position = "absolute";
        dropdown.style.top = rect.bottom + 5 + "px";
        dropdown.style.left = rect.left + "px";
        dropdown.style.zIndex = "1000";
        document.body.appendChild(dropdown);
        const handleClickOutside = (evt: MouseEvent) => {
            if (!dropdown.contains(evt.target as Node) && !button.contains(evt.target as Node)) {
                dropdown.remove();
                document.removeEventListener("click", handleClickOutside);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", handleClickOutside);
        }, 100);
    }

    showFileSelectionModal(files: TFile[], didaId: string) {
        const modal = new Modal(this.app);
        modal.titleEl.setText("选择包含任务链接的文件");
        const container = modal.contentEl.createDiv();
        container.createEl("p", { text: `找到 ${files.length} 个包含任务链接的文件:` });
        const list = container.createDiv("file-selection-list");
        files.forEach(file => {
            const item = list.createDiv("file-item");
            item.createEl("span", { text: file.basename, cls: "file-name" });
            item.createEl("span", { text: file.path, cls: "file-path" });
            item.onclick = async () => {
                modal.close();
                await this.openFileAndLocateDidaId(file, didaId);
            };
        });
        modal.open();
    }

    async deleteDidaIdFromMarkdown(didaId: string) {
        try {
            this._isUpdatingNativeTaskStatus = true;
            const files = await this.findFilesWithDidaId(didaId);
            if (files.length > 0) {
                for (const file of files) {
                    try {
                        const content = await this.app.vault.read(file);
                        const lines = content.split("\n");
                        const escaped = didaId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                        const regex = new RegExp(`\\[🔗Dida\\]\\(obsidian://dida-task\\?didaId=${escaped}\\)`);
                        const newContent = lines.filter(line => !regex.test(line)).join("\n");
                        if (newContent !== content) await this.app.vault.modify(file, newContent);
                    } catch (e) { }
                }
            }
        } catch (e) { }
        finally {
            this._isUpdatingNativeTaskStatus = false;
        }
    }

    openTaskDetails(didaId: string) {
        const task = this.settings.tasks.find(t => t.didaId === didaId);
        if (task) {
            this.openTaskViewWithCache().then(() => {
                this.showTaskDetailsInViewOptimized(task);
            }).catch(() => {
                this.showTaskDetailsInView(task);
            });
        } else {
            new Notice("该任务已完成");
        }
    }

    showTaskDetailsInViewOptimized(task: DidaTask) {
        try {
            const el = document.querySelector(`[data-task-id="${task.id}"]`) as HTMLElement | null;
            if (el) {
                if (el.classList.contains("dida-timeline-task-item")) {
                    const modal = this.getTimelineModalSafely();
                    if (modal && modal.toggleTimelineTaskDetails) {
                        modal.toggleTimelineTaskDetails(el, task);
                        this.scrollToTaskItem(el);
                    } else {
                        const title = el.querySelector(".dida-timeline-task-title, .dida-task-title-clickable");
                        if (title) {
                            const evt = new Event("click", { bubbles: true });
                            title.dispatchEvent(evt);
                            this.scrollToTaskItem(el);
                        }
                    }
                } else {
                    const view = this.getTaskViewSafely();
                    if (view && view.toggleTaskDetails) {
                        view.toggleTaskDetails(el, task);
                        this.scrollToTaskItem(el);
                    } else {
                        const title = el.querySelector(".dida-task-title, .dida-task-title-clickable");
                        if (title) {
                            const evt = new Event("click", { bubbles: true });
                            title.dispatchEvent(evt);
                            this.scrollToTaskItem(el);
                        } else {
                            this.showTaskDetailsInView(task);
                        }
                    }
                }
            } else {
                this.refreshTaskView();
                requestAnimationFrame(() => {
                    const next = document.querySelector(`[data-task-id="${task.id}"]`) as HTMLElement | null;
                    if (next) {
                        if (next.classList.contains("dida-timeline-task-item")) {
                            const modal = this.getTimelineModalSafely();
                            if (modal && modal.toggleTimelineTaskDetails) {
                                modal.toggleTimelineTaskDetails(next, task);
                                this.scrollToTaskItem(next);
                            } else {
                                this.showTaskDetailsInView(task);
                            }
                        } else {
                            const view = this.getTaskViewSafely();
                            if (view && view.toggleTaskDetails) {
                                view.toggleTaskDetails(next, task);
                                this.scrollToTaskItem(next);
                            } else {
                                this.showTaskDetailsInView(task);
                            }
                        }
                    } else {
                        this.showTaskDetailsInView(task);
                    }
                });
            }
        } catch (e) {
            this.showTaskDetailsInView(task);
        }
    }

    showTaskDetailsInView(task: DidaTask) {
        for (const el of document.querySelectorAll(".dida-task-item, .dida-timeline-task-item")) {
            if ((el as HTMLElement).getAttribute("data-task-id") === task.id) {
                if ((el as HTMLElement).classList.contains("dida-timeline-task-item")) {
                    const modal = this.getTimelineModalSafely();
                    if (modal && modal.toggleTimelineTaskDetails) {
                        modal.toggleTimelineTaskDetails(el as HTMLElement, task);
                        this.scrollToTaskItem(el as HTMLElement);
                    } else {
                        const title = (el as HTMLElement).querySelector(".dida-timeline-task-title, .dida-task-title-clickable");
                        if (title) {
                            const evt = new Event("click", { bubbles: true });
                            title.dispatchEvent(evt);
                            this.scrollToTaskItem(el as HTMLElement);
                        }
                    }
                } else {
                    const title = (el as HTMLElement).querySelector(".dida-task-title, .dida-task-title-clickable");
                    if (title) {
                        const evt = new Event("click", { bubbles: true });
                        title.dispatchEvent(evt);
                        this.scrollToTaskItem(el as HTMLElement);
                    } else {
                        const view = this.getTaskViewSafely();
                        if (view && view.toggleTaskDetails) {
                            view.toggleTaskDetails(el as HTMLElement, task);
                            this.scrollToTaskItem(el as HTMLElement);
                        }
                    }
                }
                return;
            }
        }
    }

    getTaskViewSafely(): TaskView | null {
        try {
            const leaves = this.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
            if (leaves.length > 0) {
                const view = leaves[0].view as TaskView;
                if (view && typeof (view as any).toggleTaskDetails === "function") return view;
            }
            if (this._cachedTaskLeaf && !this._cachedTaskLeaf.isDestroyed()) {
                const view = this._cachedTaskLeaf.view as TaskView;
                if (view && typeof (view as any).toggleTaskDetails === "function") return view;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    getTimelineModalSafely(): any | null {
        try {
            for (const modalEl of document.querySelectorAll(".modal")) {
                if (modalEl.querySelector(".dida-timeline-modal") || modalEl.querySelector(".dida-timeline-container")) {
                    const modal = this.app.workspace.getActiveModal();
                    if (modal && typeof (modal as any).toggleTimelineTaskDetails === "function") return modal;
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    clearTaskViewCache() {
        this._cachedTaskLeaf = null;
    }

    scrollToTaskItem(el: HTMLElement) {
        if (el) {
            try {
                el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
                el.style.transition = "background-color 0.3s ease";
                el.style.backgroundColor = "var(--background-modifier-hover)";
                setTimeout(() => {
                    el.style.backgroundColor = "";
                    el.style.transition = "";
                }, 3000);
            } catch (e) { }
        }
    }

    setupDidaLinkHandler() {
        new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        (node as HTMLElement).querySelectorAll('a[href*="obsidian://dida-task/"]').forEach(link => {
                            link.addEventListener("click", evt => {
                                const didaId = (link as HTMLAnchorElement).href.split("obsidian://dida-task/")[1];
                                this.openTaskDetails(didaId);
                                evt.preventDefault();
                                evt.stopPropagation();
                            });
                        });
                    }
                });
            });
        }).observe(document.body, { childList: true, subtree: true });
    }

    async saveTaskDetails(index: number, title: string, content: string, contentField: string, startDate?: Date | string, dueDate?: boolean) {
        const task = this.settings.tasks[index];
        if (task) {
            const trimmed = title.trim();
            if (trimmed) {
                const titleChanged = task.title !== trimmed;
                const oldTitle = task.title;
                const oldDueDate = task.dueDate;
                let dateChanged = false;
                let due = startDate as any;
                if (startDate !== undefined) {
                    if (startDate instanceof Date) {
                        const d = startDate;
                        const y = d.getFullYear();
                        const m = String(d.getMonth() + 1).padStart(2, "0");
                        const day = String(d.getDate()).padStart(2, "0");
                        const h = String(d.getHours()).padStart(2, "0");
                        const min = String(d.getMinutes()).padStart(2, "0");
                        const s = String(d.getSeconds()).padStart(2, "0");
                        const offset = d.getTimezoneOffset();
                        const oh = Math.abs(Math.floor(offset / 60));
                        const om = Math.abs(offset % 60);
                        const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                        due = `${y}-${m}-${day}T${h}:${min}:${s}${tz}`;
                    }
                    dateChanged = oldDueDate !== due;
                }
                task.title = trimmed;
                if (startDate !== undefined) task.dueDate = due;
                if (dueDate !== undefined) task.isAllDay = dueDate as any;
                if (contentField === "desc") task.desc = content;
                else task.content = content;
                task.updatedAt = new Date().toISOString();
                await this.saveSettings();
                if (titleChanged && task.didaId) {
                    const leaves = this.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
                    if (leaves.length > 0) {
                        const view = leaves[0].view as any;
                        if (view.updateNativeTaskTitle) await view.updateNativeTaskTitle(task, oldTitle, trimmed);
                    }
                }
                if (dateChanged && task.didaId) {
                    const leaves = this.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
                    if (leaves.length > 0) {
                        const view = leaves[0].view as any;
                        if (view.updateNativeTaskDueDate) await view.updateNativeTaskDueDate(task, oldDueDate, due);
                    }
                }
            } else {
                new Notice("任务标题不能为空");
            }
        }
    }

    updateTaskStatusDirectly(task: DidaTask, status: number) {
        task.status = status;
        if (status === 2) {
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
            task.completed = true;
            task.completedTime = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
        } else {
            task.completed = false;
            task.completedTime = null;
        }
        task.updatedAt = new Date().toISOString();
    }
}
