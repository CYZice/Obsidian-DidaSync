import { App, Editor, EditorPosition } from "obsidian";
import { RRuleParser } from "../core/RRuleParser";
import DidaSyncPlugin from "../main";

export class TaskActionMenu {
    app: App;
    plugin: DidaSyncPlugin;
    editor: Editor | null;
    cursor: EditorPosition | null;
    onAction: (action: string, data?: any) => void;
    showingDateMenu: boolean;
    menuElement: HTMLElement | null;
    isOpen: boolean;
    selectedIndex: number;
    menuItems: HTMLElement[];
    initialTaskInfo: any;
    keyHandler: ((e: KeyboardEvent) => void) | null = null;
    clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
    scrollHandler: (() => void) | null = null;

    constructor(app: App, plugin: DidaSyncPlugin, editor: Editor, cursor: EditorPosition, onAction: (action: string, data?: any) => void) {
        this.app = app;
        this.plugin = plugin;
        this.editor = editor;
        this.cursor = cursor;
        this.onAction = onAction;
        this.showingDateMenu = false;
        this.menuElement = null;
        this.isOpen = false;
        this.selectedIndex = 0;
        this.menuItems = [];
        this.initialTaskInfo = this.extractInitialTaskInfo();
    }

    extractInitialTaskInfo() {
        try {
            if (!this.editor || !this.cursor) return null;
            var lineContent = this.editor.getLine(this.cursor.line);
            if (!lineContent) return null;
            var match = lineContent.match(/\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-f0-9]+)\)/);
            if (!match) return null;
            let didaId = match[1];
            var task = this.plugin.settings.tasks.find(t => t.didaId === didaId);
            if (!task) return null;

            var title = task.title || "";
            let date = null;
            if (task.dueDate) {
                const dateMatch = task.dueDate.match(/(\d{4}-\d{2}-\d{2})/);
                date = dateMatch ? dateMatch[1] : null;
            }
            var status = task.status || 0;
            return {
                didaId: didaId,
                title: title,
                date: date,
                status: status,
                line: this.cursor.line
            };
        } catch (t) {
            return null;
        }
    }

    extractTaskInfo() {
        try {
            if (this.editor && this.cursor) {
                var lineContent = this.editor.getLine(this.cursor.line);
                if (lineContent) {
                    var linkMatch = lineContent.match(/\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-f0-9]+)\)/);
                    var taskMatch = lineContent.match(/^(\s*)-\s\[[ x]\]\s*(.+)$/);
                    if (linkMatch && taskMatch) {
                        var didaId = linkMatch[1];
                        let title = taskMatch[2].trim();
                        title = title.replace(/\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-f0-9]+\)\s*/g, "").trim();
                        title = title.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*/g, "").trim();
                        return {
                            didaId: didaId,
                            title: title,
                            line: this.cursor.line
                        };
                    }
                }
            }
            return null;
        } catch (t) {
            return null;
        }
    }

    isSamePosition(editor: Editor, cursor: EditorPosition) {
        if (!this.editor || !this.cursor || this.editor !== editor || this.cursor.line !== cursor.line) return false;
        const line = editor.getLine(cursor.line);
        return !!line.match(/^(\s*)-\s\[\s\]\s(.*)$/);
    }

    open() {
        if (this.isOpen && this.menuElement) return;

        document.querySelectorAll(".task-action-menu-inline").forEach(el => {
            if (el !== this.menuElement) el.remove();
        });

        this.createMenuElement();
        this.positionMenu();
        this.bindEvents();
        this.isOpen = true;
        this.showingDateMenu = false;
        this.renderMainMenu();
    }

    createMenuElement() {
        this.menuElement = document.createElement("div");
        this.menuElement.addClass("task-action-menu-inline");
        document.body.appendChild(this.menuElement);
    }

    positionMenu() {
        if (!this.menuElement || !this.editor || !this.cursor) return;

        try {
            this.menuElement.style.position = "fixed";
            this.menuElement.style.zIndex = "1000";
            this.menuElement.style.visibility = "visible";

            let coords: any = null;
            // @ts-ignore
            if (this.editor.coordsAtPos && typeof this.editor.coordsAtPos === "function") {
                try { coords = this.editor.coordsAtPos(this.cursor); } catch (t) { }
            }
            // @ts-ignore
            if (!coords && this.editor.cm && this.editor.cm.coordsAtPos) {
                try {
                    // @ts-ignore
                    const offset = this.editor.posToOffset(this.cursor);
                    // @ts-ignore
                    coords = this.editor.cm.coordsAtPos(offset);
                } catch (t) { }
            }
            // @ts-ignore
            if (!coords && this.editor.cursorCoords && typeof this.editor.cursorCoords === "function") {
                try { coords = this.editor.cursorCoords(true, "window"); } catch (t) { }
            }

            if (coords && coords.left !== undefined && coords.top !== undefined) {
                this.menuElement.style.left = coords.left + "px";
                this.menuElement.style.top = coords.top + 20 + "px";
            } else {
                let editorEl: HTMLElement | null = null;
                // @ts-ignore
                if (this.editor.cm && this.editor.cm.dom) editorEl = this.editor.cm.dom;
                // @ts-ignore
                else if (this.editor.getInputField && typeof this.editor.getInputField === "function") editorEl = this.editor.getInputField();
                // @ts-ignore
                else if (this.editor.dom) editorEl = this.editor.dom;
                if (!editorEl) return;
                const lines = editorEl.querySelectorAll(".cm-line");
                const currentLine = this.editor.getLine(this.cursor.line);
                let lineEl: Element | null = null;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].textContent.replace(/📅\s*\d{4}-\d{2}-\d{2}/, "").replace(/\[\[.*?\]\]/g, "").trim() === currentLine.replace(/📅\s*\d{4}-\d{2}-\d{2}/, "").replace(/\[\[.*?\]\]/g, "").trim()) {
                        lineEl = lines[i];
                        break;
                    }
                }
                if (lineEl) {
                    const rect = (lineEl as HTMLElement).getBoundingClientRect();
                    this.menuElement.style.left = rect.left + "px";
                    this.menuElement.style.top = rect.bottom + 5 + "px";
                } else {
                    const rect = editorEl.getBoundingClientRect();
                    this.menuElement.style.left = rect.left + "px";
                    this.menuElement.style.top = rect.bottom + 5 + "px";
                }
            }

            var rect = this.menuElement.getBoundingClientRect();
            var winHeight = window.innerHeight;
            var winWidth = window.innerWidth;

            if (rect.bottom > winHeight) {
                var top = parseInt(this.menuElement.style.top);
                this.menuElement.style.top = top - rect.height - 40 + "px";
            }
            if (rect.right > winWidth) {
                this.menuElement.style.left = winWidth - rect.width - 10 + "px";
            }
            if (rect.left < 10) {
                this.menuElement.style.left = "10px";
            }
        } catch (t) { }
    }

    bindEvents() {
        this.keyHandler = (e: KeyboardEvent) => {
            if ("Escape" === e.key) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                this.close();
            } else if ("ArrowDown" === e.key) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                this.navigateDown();
            } else if ("ArrowUp" === e.key) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                this.navigateUp();
            } else if ("Enter" === e.key) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                this.selectCurrentItem();
            }
        };
        document.addEventListener("keydown", this.keyHandler, true);

        this.clickOutsideHandler = (e: MouseEvent) => {
            if (this.menuElement && !this.menuElement.contains(e.target as Node)) {
                this.close();
            }
        };
        setTimeout(() => {
            if (this.clickOutsideHandler) document.addEventListener("click", this.clickOutsideHandler);
        }, 100);

        this.scrollHandler = () => {
            if (this.isOpen && this.menuElement) this.positionMenu();
        };

        // @ts-ignore
        const scrollDom = this.editor?.cm?.scrollDOM || (this.editor as any)?.scrollDOM || document.querySelector(".workspace-leaf-content");
        if (scrollDom) scrollDom.addEventListener("scroll", this.scrollHandler, { passive: true });
        window.addEventListener("scroll", this.scrollHandler, { passive: true });
    }

    close() {
        if (!this.isOpen) return;

        this.detectAndSyncChanges();

        if (this.keyHandler) {
            document.removeEventListener("keydown", this.keyHandler, true);
            this.keyHandler = null;
        }
        if (this.clickOutsideHandler) {
            document.removeEventListener("click", this.clickOutsideHandler);
            this.clickOutsideHandler = null;
        }
        if (this.scrollHandler) {
            // @ts-ignore
            const scrollDom = this.editor?.cm?.scrollDOM || (this.editor as any)?.scrollDOM || document.querySelector(".workspace-leaf-content");
            if (scrollDom) scrollDom.removeEventListener("scroll", this.scrollHandler);
            window.removeEventListener("scroll", this.scrollHandler);
            this.scrollHandler = null;
        }
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
        if (this.plugin && this.plugin.currentTaskActionMenu === this) {
            this.plugin.currentTaskActionMenu = null;
        }
        this.isOpen = false;
    }

    detectAndSyncChanges() {
        try {
            if (this.plugin && this.plugin.settings && this.plugin.settings.enableNativeTaskSync && this.editor && this.cursor) {
                const line = this.editor.getLine(this.cursor.line);
                if (line) {
                    const linkMatch = line.match(/\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-f0-9]+)\)/);
                    if (linkMatch) {
                        const didaId = linkMatch[1];
                        const status = line.match(/^(\s*)-\s\[x\]/i) ? 2 : 0;
                        const taskMatch = line.match(/^(\s*)-\s\[[ x]\]\s*(.+)$/);
                        let title = taskMatch ? taskMatch[2].trim() : "";
                        title = title.replace(/\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-f0-9]+\)\s*/g, "").trim();
                        title = title.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*/g, "").trim();
                        const dateRegex = /^(\s*)-\s\[[ x]\]\s*(.+)📅\s*(\d{4}-\d{2}-\d{2})(.*)$/;
                        const dateMatch = line.match(dateRegex);
                        const newTitle = dateMatch ? dateMatch[2].trim() : title;
                        const newDate = dateMatch ? dateMatch[3] : null;
                        let titleChanged = false;
                        let dateChanged = false;
                        let statusChanged = false;
                        if (this.initialTaskInfo) {
                            if (title && title !== this.initialTaskInfo.title) titleChanged = true;
                            const oldDate = this.initialTaskInfo.date || null;
                            if (newDate !== oldDate) dateChanged = true;
                            const oldStatus = this.initialTaskInfo.status || 0;
                            if (status !== oldStatus) statusChanged = true;
                        } else {
                            titleChanged = !!title;
                            dateChanged = !!newDate;
                        }
                        if (titleChanged && title) {
                            setTimeout(() => {
                                try { this.plugin.handleTitleChange(didaId, title); } catch (t) { }
                            }, 100);
                        }
                        if (dateChanged && newDate) {
                            setTimeout(() => {
                                try { this.plugin.handleDateChange(didaId, newDate, newTitle); } catch (t) { }
                            }, 150);
                        }
                        if (statusChanged) {
                            setTimeout(async () => {
                                try {
                                    const task = this.plugin.settings.tasks.find(t => t.didaId === didaId);
                                    if (task) {
                                        if (status === 2 && RRuleParser.hasRepeatRule(task)) {
                                            const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === didaId);
                                            if (idx !== -1) await this.plugin.toggleTask(idx);
                                        } else {
                                            this.plugin.updateTaskStatusDirectly(task, status);
                                            await this.plugin.saveSettings();
                                            this.plugin.refreshTaskView();
                                            if (this.plugin.settings.accessToken) {
                                                setTimeout(async () => {
                                                    try { await this.plugin.toggleTaskInDidaList(task); } catch (t) { }
                                                }, 0);
                                            }
                                        }
                                    }
                                } catch (t) { }
                            }, 200);
                        }
                    }
                }
            }
        } catch (t) { }
    }

    async checkAndSyncTitleChange() {
        try {
            if (this.initialTaskInfo && this.plugin.settings.enableNativeTaskSync) {
                const info = this.extractTaskInfoFromLine(this.initialTaskInfo.line);
                if (info && info.didaId === this.initialTaskInfo.didaId && info.title !== this.initialTaskInfo.title) {
                    if (this.plugin.isTaskActionInProgress) {
                        setTimeout(() => { this.plugin.handleTitleChange(info.didaId, info.title); }, 1000);
                    } else {
                        setTimeout(() => { this.plugin.handleTitleChange(info.didaId, info.title); }, 100);
                    }
                }
            }
        } catch (t) { }
    }

    extractTaskInfoFromLine(lineNumber: number) {
        try {
            if (this.editor) {
                const line = this.editor.getLine(lineNumber);
                if (line) {
                    const linkMatch = line.match(/\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-f0-9]+)\)/);
                    const taskMatch = line.match(/^(\s*)-\s\[[ x]\]\s*(.+)$/);
                    if (linkMatch && taskMatch) {
                        const didaId = linkMatch[1];
                        let title = taskMatch[2].trim();
                        title = title.replace(/\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-f0-9]+\)\s*/g, "").trim();
                        title = title.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*/g, "").trim();
                        return { didaId, title, line: lineNumber };
                    }
                }
            }
            return null;
        } catch (t) {
            return null;
        }
    }

    renderMainMenu() {
        if (!this.menuElement) return;
        this.menuElement.empty();
        this.selectedIndex = 0;
        this.menuItems = [];

        this.menuElement.createEl("div", { cls: "task-action-menu-title" }).textContent = "选择操作";

        const optionsDiv = this.menuElement.createEl("div", { cls: "task-action-menu-options" });

        const syncOption = optionsDiv.createEl("div", { cls: "task-action-menu-option", text: "🔗 同步到滴答" });
        syncOption.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.close();
            this.onAction("sync");
        });
        this.menuItems.push(syncOption);

        const searchOption = optionsDiv.createEl("div", { cls: "task-action-menu-option", text: "🔍 关联/搜索任务" });
        searchOption.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.close();
            this.onAction("search");
        });
        this.menuItems.push(searchOption);

        const dateOption = optionsDiv.createEl("div", { cls: "task-action-menu-option", text: "📅 到期日期" });
        dateOption.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.showingDateMenu = true;
            this.renderDateMenu();
        });
        this.menuItems.push(dateOption);

        this.updateSelectedItem();
    }

    renderDateMenu() {
        if (!this.menuElement) return;
        this.menuElement.empty();
        this.selectedIndex = 0;
        this.menuItems = [];

        this.menuElement.createEl("div", { cls: "task-action-menu-title" }).textContent = "选择日期";

        this.menuElement.createEl("div", { cls: "task-action-menu-back", text: "← 返回" }).addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.showingDateMenu = false;
            this.renderMainMenu();
        });

        const optionsDiv = this.menuElement.createEl("div", { cls: "task-action-menu-options" });

        this.getDateOptions().forEach(opt => {
            const el = optionsDiv.createEl("div", { cls: "task-action-menu-option", text: opt.label });
            el.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                this.close();
                this.onAction("date", { date: opt.date });
            });
            this.menuItems.push(el);
        });

        this.updateSelectedItem();
    }

    getDateOptions() {
        const today = new Date();
        const options = [];

        options.push({ label: `今天 (${this.formatDate(today)})`, date: this.formatDate(today) });

        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        options.push({ label: `明天 (${this.formatDate(tomorrow)})`, date: this.formatDate(tomorrow) });

        const afterTomorrow = new Date(today); afterTomorrow.setDate(today.getDate() + 2);
        options.push({ label: `后天 (${this.formatDate(afterTomorrow)})`, date: this.formatDate(afterTomorrow) });

        // Next Saturday
        const nextSat = new Date(today);
        const daysToSat = (6 - today.getDay() + 7) % 7;
        nextSat.setDate(today.getDate() + (daysToSat === 0 ? 7 : daysToSat));
        options.push({ label: `星期六 (${this.formatDate(nextSat)})`, date: this.formatDate(nextSat) });

        // Next Sunday
        const nextSun = new Date(today);
        const daysToSun = (7 - today.getDay()) % 7;
        nextSun.setDate(today.getDate() + (daysToSun === 0 ? 7 : daysToSun));
        options.push({ label: `星期日 (${this.formatDate(nextSun)})`, date: this.formatDate(nextSun) });

        return options;
    }

    navigateDown() {
        if (this.menuItems.length === 0) return;
        this.selectedIndex = (this.selectedIndex + 1) % this.menuItems.length;
        this.updateSelectedItem();
    }

    navigateUp() {
        if (this.menuItems.length === 0) return;
        this.selectedIndex = (this.selectedIndex - 1 + this.menuItems.length) % this.menuItems.length;
        this.updateSelectedItem();
    }

    updateSelectedItem() {
        if (this.menuItems.length === 0) return;
        this.menuItems.forEach(el => el.removeClass("task-action-menu-option-selected"));
        const selected = this.menuItems[this.selectedIndex];
        if (selected) {
            selected.addClass("task-action-menu-option-selected");
            selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }

    selectCurrentItem() {
        if (this.menuItems.length > 0 && this.menuItems[this.selectedIndex]) {
            this.menuItems[this.selectedIndex].click();
        }
    }

    formatDate(date: Date) {
        return date.getFullYear() + `-${String(date.getMonth() + 1).padStart(2, "0")}-` + String(date.getDate()).padStart(2, "0");
    }
}
