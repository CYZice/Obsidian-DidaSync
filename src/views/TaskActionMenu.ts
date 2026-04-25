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
    _calendarViewMonth: Date | null = null;

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
        this.menuElement.removeClass("task-action-menu-with-calendar");
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
            this.renderSearchMenu();
        });
        this.menuItems.push(searchOption);

        const dateOption = optionsDiv.createEl("div", { cls: "task-action-menu-option", text: "📅 到期日期" });
        dateOption.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this._calendarViewMonth = null;
            this.showingDateMenu = true;
            this.renderDateMenu();
        });
        this.menuItems.push(dateOption);

        this.updateSelectedItem();
    }

    renderDateMenu() {
        if (!this.menuElement) return;
        this.menuElement.empty();
        this.menuElement.addClass("task-action-menu-with-calendar");
        this.selectedIndex = 0;
        this.menuItems = [];

        const today = new Date();
        const todayStr = this.formatDate(today);

        if (!this._calendarViewMonth) {
            const initial = this.initialTaskInfo;
            if (initial && initial.date && /^\d{4}-\d{2}-\d{2}$/.test(initial.date)) {
                const parts = initial.date.split("-");
                const year = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1;
                if (!isNaN(year) && !isNaN(month)) {
                    this._calendarViewMonth = new Date(year, month, 1);
                }
            }
            if (!this._calendarViewMonth) {
                this._calendarViewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            }
        }

        this.menuElement.createEl("div", { cls: "task-action-menu-title" }).textContent = "选择到期日期";

        const backBtn = this.menuElement.createEl("div", { cls: "task-action-menu-back", text: "← 返回" });
        backBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._calendarViewMonth = null;
            this.showingDateMenu = false;
            this.renderMainMenu();
        });
        this.menuItems.push(backBtn);

        const year = this._calendarViewMonth.getFullYear();
        const month = this._calendarViewMonth.getMonth();

        const navDiv = this.menuElement.createEl("div", { cls: "task-action-cal-nav" });

        const prevBtn = navDiv.createEl("span", { cls: "task-action-cal-nav-btn", text: "‹", attr: { title: "上一月" } });
        prevBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._calendarViewMonth = new Date(year, month - 1, 1);
            this.renderDateMenu();
        });

        const monthLabel = navDiv.createEl("span", { cls: "task-action-cal-nav-label" });
        monthLabel.textContent = `${year}年${month + 1}月`;

        const nextBtn = navDiv.createEl("span", { cls: "task-action-cal-nav-btn", text: "›", attr: { title: "下一月" } });
        nextBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._calendarViewMonth = new Date(year, month + 1, 1);
            this.renderDateMenu();
        });

        const weekdaysDiv = this.menuElement.createEl("div", { cls: "task-action-cal-weekdays" });
        ["日", "一", "二", "三", "四", "五", "六"].forEach(day => {
            weekdaysDiv.createEl("span", { cls: "task-action-cal-weekday", text: day });
        });

        const gridDiv = this.menuElement.createEl("div", { cls: "task-action-cal-grid" });
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const existingDate = this.initialTaskInfo && this.initialTaskInfo.date;
        let dayCount = 1;
        const totalCells = 7 * Math.ceil((firstDay + daysInMonth) / 7);

        for (let i = 0; i < totalCells; i++) {
            if (i < firstDay || dayCount > daysInMonth) {
                gridDiv.createDiv({ cls: "task-action-cal-cell task-action-cal-cell-empty" });
            } else {
                const cellDate = new Date(year, month, dayCount);
                const dateStr = this.formatDate(cellDate);
                const cell = gridDiv.createDiv({ cls: "task-action-cal-cell", text: String(dayCount), attr: { role: "button", tabindex: "0" } });

                if (dateStr === todayStr) {
                    cell.addClass("task-action-cal-cell-today");
                    cell.title = "今天";
                }
                if (existingDate && dateStr === existingDate) {
                    cell.addClass("task-action-cal-cell-due");
                }

                cell.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.close();
                    this.onAction("date", { date: dateStr });
                });

                this.menuItems.push(cell);
                dayCount++;
            }
        }

        this.updateSelectedItem();
        this.positionMenu();
    }

    renderSearchMenu() {
        if (!this.menuElement || !this.editor || !this.cursor) return;

        this.menuElement.empty();
        this.menuElement.removeClass("task-action-menu-with-calendar");
        this.menuElement.addClass("task-action-menu-with-search");
        this.selectedIndex = 0;
        this.menuItems = [];

        this.menuElement.createEl("div", { cls: "task-action-menu-title" }).textContent = "关联/搜索任务";

        const backBtn = this.menuElement.createEl("div", { cls: "task-action-menu-back", text: "← 返回" });
        backBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showingDateMenu = false;
            this.renderMainMenu();
        });
        this.menuItems.push(backBtn);

        const searchContainer = this.menuElement.createEl("div", { cls: "dida-search-container" });
        const searchInput = searchContainer.createEl("input", {
            type: "text",
            cls: "dida-search-input",
            attr: { placeholder: "搜索任务或输入新任务标题（Enter确认）..." }
        });
        searchInput.focus();

        const resultsContainer = this.menuElement.createEl("div", { cls: "dida-suggestions-container" });

        const tasks = (this.plugin.settings.tasks || []).filter(t => {
            if (t.parentId) return false;
            const isCompleted = t.completed === true || t.completed === 2 || t.status === 2;
            const isArchived = t.projectClosed === true;
            if (isCompleted) return false;
            if (!this.plugin.settings.showArchivedProjects && isArchived) return false;
            return true;
        }).sort((a, b) => {
            const dateA = new Date(a.updatedAt || a.createdAt).getTime();
            const dateB = new Date(b.updatedAt || b.createdAt).getTime();
            return dateB - dateA;
        });

        const renderResults = (query: string) => {
            resultsContainer.empty();
            this.menuItems = [backBtn];

            const filtered = query
                ? tasks.filter(t => {
                    const titleMatch = t.title && t.title.toLowerCase().includes(query.toLowerCase());
                    const projectMatch = t.projectName && t.projectName.toLowerCase().includes(query.toLowerCase());
                    return titleMatch || projectMatch;
                })
                : tasks;

            if (filtered.length === 0) {
                const noResult = resultsContainer.createEl("div", { cls: "dida-no-tasks", text: query ? "没有找到匹配的任务，按Enter创建新任务" : "没有找到任务" });
                this.menuItems.push(noResult);
            } else {
                filtered.forEach((task, idx) => {
                    const item = resultsContainer.createEl("div", { cls: "dida-suggestion-item" });
                    item.setAttribute("data-index", idx.toString());

                    const titleDiv = document.createElement("div");
                    titleDiv.className = "dida-suggestion-title";
                    titleDiv.textContent = task.title || "无标题任务";
                    if (task.completed) titleDiv.classList.add("completed");
                    item.appendChild(titleDiv);

                    if (task.projectName) {
                        const projectDiv = document.createElement("div");
                        projectDiv.className = "dida-suggestion-project";
                        projectDiv.textContent = "项目: " + task.projectName;
                        item.appendChild(projectDiv);
                    }

                    item.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (this.onAction) {
                            this.onAction("selectTask", { task });
                        }
                        this.close();
                    });

                    this.menuItems.push(item);
                });
            }

            this.updateSelectedItem();
        };

        searchInput.addEventListener("input", (e) => {
            const query = (e.target as HTMLInputElement).value;
            renderResults(query);
        });

        renderResults("");

        this.updateSelectedItem();
        this.positionMenu();
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
