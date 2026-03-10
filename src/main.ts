import { Editor, EditorPosition, MarkdownView, Menu, Notice, Plugin, TFile } from 'obsidian';
import { DidaApiClient } from './api/DidaApiClient';
import { NativeTaskSyncManager } from './managers/NativeTaskSyncManager';
import { RepeatTaskManager } from './managers/RepeatTaskManager';
import { SyncManager } from './managers/SyncManager';
import { AddTaskToProjectModal } from './modals/AddTaskToProjectModal';
import { TaskSuggestionPopup } from './modals/TaskSuggestionPopup';
import { TimelineViewModal } from './modals/TimelineViewModal';
import { DidaSyncSettingTab } from './settings/DidaSyncSettingTab';
import { DEFAULT_SETTINGS, DidaSyncSettings, DidaTask } from './types';
import { debounce } from './utils';
import { DidaTimeBlockView, TIME_BLOCK_VIEW_TYPE } from './views/DidaTimeBlockView';
import { TaskActionMenu } from './views/TaskActionMenu';
import { TASK_VIEW_TYPE, TaskView } from './views/TaskView';

export default class DidaSyncPlugin extends Plugin {
    settings: DidaSyncSettings;
    apiClient: DidaApiClient;
    syncManager: SyncManager;
    nativeTaskSyncManager: NativeTaskSyncManager;
    repeatTaskManager: RepeatTaskManager;
    currentTaskActionMenu: TaskActionMenu | null = null;
    isTaskActionInProgress: boolean = false;
    isPluginActivated: boolean = false;
    syncIntervalId: number | null = null;
    debouncedEditorChange: (editor: Editor, info: any) => void;

    async onload() {
        await this.loadSettings();

        this.apiClient = new DidaApiClient(this);
        this.syncManager = new SyncManager(this);
        this.nativeTaskSyncManager = new NativeTaskSyncManager(this);
        this.repeatTaskManager = new RepeatTaskManager(this);

        this.addSettingTab(new DidaSyncSettingTab(this.app, this));

        this.registerView(TASK_VIEW_TYPE, (leaf) => new TaskView(leaf, this));
        this.registerView(TIME_BLOCK_VIEW_TYPE, (leaf) => new DidaTimeBlockView(leaf, this));

        this.addRibbonIcon('check-square', 'Dida Sync', () => {
            this.openTaskViewWithCache();
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
            name: '同步滴答清单任务',
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

        this.initializePluginFeatures();

        // Wait for layout ready to initialize sync
        this.app.workspace.onLayoutReady(() => {
            this.syncManager.initializeSync();
            this.initializeMarkdownTaskLink();
        });
    }

    async onunload() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }
        // Clean up menus
        const menus = document.querySelectorAll(".task-action-menu-inline");
        menus.forEach(m => m.remove());
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    initializePluginFeatures() {
        this.isPluginActivated = !!this.settings.accessToken;

        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (file && this.settings.enableNativeTaskSync) {
                // Logic to scan file for tasks if needed
            }
        }));

        this.debouncedEditorChange = debounce((editor: Editor, info: any) => {
            this.handleEditorChange(editor, info);
        }, 500);

        this.registerEvent(this.app.workspace.on('editor-change', this.debouncedEditorChange));

        // Register markdown post processor for links
        this.registerMarkdownPostProcessor((element, context) => {
            const links = element.querySelectorAll('a.internal-link');
            // ... (Custom link rendering if needed, or handle obsidian protocol links)
        });

        // Protocol handler
        this.registerObsidianProtocolHandler("dida-task", (params) => {
            if (params.didaId) {
                this.openTaskDetails(params.didaId);
            }
        });
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
            await this.syncManager.syncFromDidaList();
        }
    }

    // Proxy methods to SyncManager
    async syncFromDidaList() {
        await this.syncManager.syncFromDidaList();
    }

    async createTaskInDidaList(task: DidaTask) {
        return this.syncManager.createTaskInDidaList(task);
    }

    async updateTaskInDidaList(task: DidaTask) {
        return this.syncManager.updateTaskInDidaList(task);
    }

    async deleteTaskInDidaList(task: DidaTask) {
        return this.syncManager.deleteTaskInDidaList(task);
    }

    async toggleTaskInDidaList(task: DidaTask) {
        return this.syncManager.toggleTaskInDidaList(task);
    }

    async syncTaskToDidaListInBackground(task: DidaTask) {
        if (this.settings.accessToken && task.didaId) {
            try {
                await this.updateTaskInDidaList(task);
            } catch (e) {
                console.error("Background sync failed", e);
            }
        }
    }

    // View Management
    async openTaskViewWithCache() {
        const leaves = this.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
        if (leaves.length > 0) {
            this.app.workspace.revealLeaf(leaves[0]);
        } else {
            const leaf = this.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: TASK_VIEW_TYPE, active: true });
                this.app.workspace.revealLeaf(leaf);
            }
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
        new TimelineViewModal(this.app, this).open();
    }

    showAddTaskToProjectModal(projectName?: string, projectId?: string, target?: HTMLElement) {
        const modal = new AddTaskToProjectModal(this.app, this);
        if (projectName && projectId) {
            // Pre-select logic if modal supports it (current implementation selects from dropdown)
            // We might need to update AddTaskToProjectModal to accept defaults
        }
        modal.open();
    }

    // Task Management
    async addTask(title: string, projectName: string, projectId: string): Promise<DidaTask> {
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

        if (this.settings.accessToken) {
            this.createTaskInDidaList(newTask).catch(console.error);
        }

        return newTask;
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
                task.completedTime = new Date().toISOString();
                task.completed = true;

                // Handle repeating tasks
                if (task.repeatFlag) {
                    await this.repeatTaskManager.handleRepeatTaskCompletion(task);
                    // handleRepeatTaskCompletion might create a new task, we need to refresh
                }
            }

            task.updatedAt = new Date().toISOString();
            await this.saveSettings();
            this.refreshTaskView();

            if (this.settings.accessToken && task.didaId) {
                this.toggleTaskInDidaList(task).catch(console.error);
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
        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
            const target = evt.target as HTMLElement;
            if (target.matches('.dida-task-link')) {
                // Handle custom link click
            }
        });
    }

    handleEditorChange(editor: Editor, info: any) {
        if (!this.settings.enableNativeTaskSync) return;

        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);

        // Trigger suggestions
        if (line.endsWith("@dida")) {
            this.showTaskSuggestions(editor, cursor);
        }

        // Check for task action menu
        if (this.currentTaskActionMenu && this.currentTaskActionMenu.isOpen) {
            // Update or close
        } else {
            // Maybe open menu if cursor is on a task
            // Using TaskActionMenu logic
            const menu = new TaskActionMenu(this.app, this, editor, cursor, (action, data) => {
                this.handleTaskAction(action, data, menu.initialTaskInfo);
            });

            if (menu.extractInitialTaskInfo()) {
                menu.open();
                this.currentTaskActionMenu = menu;
            }
        }
    }

    showTaskSuggestions(editor: Editor, cursor: EditorPosition) {
        // Remove trigger
        const line = editor.getLine(cursor.line);
        const before = line.substring(0, cursor.ch - 5);
        const after = line.substring(cursor.ch);
        editor.replaceRange(before + after, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
        editor.setCursor({ line: cursor.line, ch: before.length });

        new TaskSuggestionPopup(this.app, this, editor, editor.getCursor(), (task) => {
            this.insertTaskLink(editor, editor.getCursor(), task);
        });
    }

    insertTaskLink(editor: Editor, cursor: EditorPosition, task: DidaTask) {
        const didaId = task.didaId || task.id; // Use id if not synced yet, but preferably didaId
        // If no didaId, we might need to wait for sync or use temporary ID?
        // Current logic assumes we use what we have.

        const linkText = ` [🔗Dida](obsidian://dida-task?didaId=${didaId})`;
        const dateText = task.dueDate ? ` 📅 ${task.dueDate.substring(0, 10)}` : "";

        // Check if line is already a task
        const line = editor.getLine(cursor.line);
        if (line.match(/^(\s*)-\s\[[ x]\]/)) {
            // Append to existing task
            editor.replaceRange(linkText + dateText, cursor);
        } else {
            // Create new task line
            const taskLine = `- [${task.status === 2 ? 'x' : ' '}] ${task.title}${linkText}${dateText}`;
            editor.replaceRange(taskLine, cursor);
        }
    }

    handleTaskAction(action: string, data: any, taskInfo: any) {
        this.isTaskActionInProgress = true;
        if (action === "sync") {
            this.syncManager.syncFromDidaList().then(() => {
                this.isTaskActionInProgress = false;
            });
        } else if (action === "date") {
            if (taskInfo && taskInfo.didaId) {
                const task = this.settings.tasks.find(t => t.didaId === taskInfo.didaId);
                if (task) {
                    // Update date logic
                    // ...
                }
            }
            this.isTaskActionInProgress = false;
        }
    }

    // File Operations
    async findFilesWithDidaId(didaId: string): Promise<TFile[]> {
        const files: TFile[] = [];
        const vaultFiles = this.app.vault.getMarkdownFiles();

        for (const file of vaultFiles) {
            const content = await this.app.vault.read(file);
            if (content.includes(`didaId=${didaId}`)) {
                files.push(file);
            }
        }
        return files;
    }

    async jumpToDidaIdInFile(didaId: string, button: HTMLElement) {
        const files = await this.findFilesWithDidaId(didaId);
        if (files.length === 0) {
            new Notice("未找到关联的文件");
            return;
        }

        if (files.length === 1) {
            await this.openFileAndLocateDidaId(files[0], didaId);
        } else {
            // Show menu to select file
            const menu = new Menu();
            files.forEach(file => {
                menu.addItem(item => {
                    item.setTitle(file.basename)
                        .onClick(async () => {
                            await this.openFileAndLocateDidaId(file, didaId);
                        });
                });
            });
            menu.showAtHTMLElement(button);
        }
    }

    async openFileAndLocateDidaId(file: TFile, didaId: string) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);

        const view = leaf.view as MarkdownView;
        if (view && view.editor) {
            const content = view.editor.getValue();
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`didaId=${didaId}`)) {
                    view.editor.setCursor({ line: i, ch: 0 });
                    view.editor.scrollIntoView({ from: { line: i, ch: 0 }, to: { line: i, ch: 0 } }, true);
                    // Highlight effect?
                    break;
                }
            }
        }
    }

    async deleteDidaIdFromMarkdown(didaId: string) {
        const files = await this.findFilesWithDidaId(didaId);
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lines = content.split("\n");
            const newLines = lines.map(line => {
                if (line.includes(`didaId=${didaId}`)) {
                    return line.replace(/\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-f0-9]+\)/g, "")
                        .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, "");
                }
                return line;
            });
            await this.app.vault.modify(file, newLines.join("\n"));
        }
        new Notice(`已从 ${files.length} 个文件中移除关联链接`);
    }

    openTaskDetails(didaId: string) {
        this.openTaskViewWithCache().then(() => {
            // Highlight task in view?
            // Need to pass parameter to view or use event
        });
    }

    async saveTaskDetails(index: number, title: string, content: string, contentField: string, startDate?: string, dueDate?: string) {
        // Helper for TimelineViewModal
        const task = this.settings.tasks[index];
        if (task) {
            task.title = title;
            if (contentField === "desc") task.desc = content;
            else task.content = content;

            if (startDate !== undefined) task.startDate = startDate;
            if (dueDate !== undefined) task.dueDate = dueDate;

            task.updatedAt = new Date().toISOString();
            await this.saveSettings();
        }
    }

    updateTaskStatusDirectly(task: DidaTask, status: number) {
        task.status = status;
        if (status === 2) {
            task.completed = true;
            task.completedTime = new Date().toISOString();
        } else {
            task.completed = false;
            task.completedTime = null;
        }
        task.updatedAt = new Date().toISOString();
    }

    handleTitleChange(didaId: string, newTitle: string) {
        const task = this.settings.tasks.find(t => t.didaId === didaId);
        if (task) {
            task.title = newTitle;
            task.updatedAt = new Date().toISOString();
            this.saveSettings();
            this.refreshTaskView();
            if (this.settings.accessToken) {
                this.updateTaskInDidaList(task).catch(console.error);
            }
        }
    }

    handleDateChange(didaId: string, newDate: string, newTitle?: string) {
        const task = this.settings.tasks.find(t => t.didaId === didaId);
        if (task) {
            if (newDate) {
                // Parse date string to ISO if needed, but usually YYYY-MM-DD from regex
                const d = new Date(newDate);
                d.setHours(0, 0, 0, 0);
                task.dueDate = d.toISOString();
            }
            if (newTitle) task.title = newTitle;

            task.updatedAt = new Date().toISOString();
            this.saveSettings();
            this.refreshTaskView();
            if (this.settings.accessToken) {
                this.updateTaskInDidaList(task).catch(console.error);
            }
        }
    }

    safeManualSync() {
        this.manualSync();
    }
}
