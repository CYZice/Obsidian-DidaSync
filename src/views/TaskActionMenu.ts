import { App, Editor, EditorPosition } from "obsidian";
import { RRuleParser } from "../core/RRuleParser";
import DidaSyncPlugin from "../main";
import { TaskSchedulePicker } from "../modals/TaskSchedulePicker";
import { parseTaskLine, tasksRepeatToRRule } from "../taskLineFormat";

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
            const parsed = parseTaskLine(lineContent);
            if (parsed && parsed.didaId) {
                let didaId = parsed.didaId;
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
            }
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
                    const parsed = parseTaskLine(lineContent);
                    if (parsed && parsed.didaId) {
                        return {
                            didaId: parsed.didaId,
                            title: parsed.title,
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
        const parsed = parseTaskLine(line);
        return !!parsed && parsed.checkbox === " ";
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

    getEditorElement() {
        // @ts-ignore
        if (this.editor?.cm?.dom) return this.editor.cm.dom as HTMLElement;
        // @ts-ignore
        if (this.editor?.getInputField && typeof this.editor.getInputField === "function") return this.editor.getInputField() as HTMLElement;
        // @ts-ignore
        if (this.editor?.dom) return this.editor.dom as HTMLElement;
        return null;
    }

    normalizeRectFromCoords(coords: any) {
        if (!coords || typeof coords.left !== "number" || typeof coords.top !== "number") return null;
        const pageLike = coords.top > window.innerHeight + 80 && coords.top - (window.scrollY || 0) < window.innerHeight + 80;
        const offsetX = pageLike ? (window.scrollX || 0) : 0;
        const offsetY = pageLike ? (window.scrollY || 0) : 0;
        const left = coords.left - offsetX;
        const top = coords.top - offsetY;
        const right = typeof coords.right === "number" ? coords.right - offsetX : left;
        const bottom = typeof coords.bottom === "number" ? coords.bottom - offsetY : top + 22;
        return { left, top, right, bottom };
    }

    getAnchorRect() {
        if (!this.editor || !this.cursor) return null;

        try {
            let coords: any = null;
            // @ts-ignore
            if (this.editor.coordsAtPos && typeof this.editor.coordsAtPos === "function") {
                try { coords = this.editor.coordsAtPos(this.cursor); } catch (t) { }
            }
            // @ts-ignore
            if (!coords && this.editor.cm?.coordsAtPos) {
                try {
                    // @ts-ignore
                    const offset = this.editor.posToOffset(this.cursor);
                    // @ts-ignore
                    coords = this.editor.cm.coordsAtPos(offset);
                } catch (t) { }
            }
            // @ts-ignore
            if (!coords && this.editor.cursorCoords && typeof this.editor.cursorCoords === "function") {
                try { coords = this.editor.cursorCoords(true, "page"); } catch (t) { }
            }
            const rect = this.normalizeRectFromCoords(coords);
            if (rect) return rect;
        } catch (t) { }

        const editorEl = this.getEditorElement();
        if (!editorEl) return null;
        const lines = Array.from(editorEl.querySelectorAll(".cm-line"));
        const lineEl = lines[Math.max(0, Math.min(this.cursor.line, lines.length - 1))] as HTMLElement | undefined;
        return lineEl?.getBoundingClientRect() || editorEl.getBoundingClientRect();
    }

    resetMenuVariantClasses() {
        if (!this.menuElement) return;
        this.menuElement.removeClass("task-action-menu-with-calendar", "task-action-menu-with-search");
    }

    positionMenu() {
        if (!this.menuElement || !this.editor || !this.cursor) return;

        try {
            this.menuElement.setCssStyles({
                position: "fixed",
                zIndex: "1000",
                visibility: "visible"
            });

            const margin = 10;
            const anchorRect = this.getAnchorRect();
            const fallbackLeft = Math.max(margin, window.innerWidth / 2 - 120);
            const fallbackTop = Math.max(margin, window.innerHeight / 2 - 120);
            const anchorLeft = anchorRect?.left ?? fallbackLeft;
            const anchorTop = anchorRect?.top ?? fallbackTop;
            const anchorBottom = anchorRect?.bottom ?? fallbackTop + 22;

            this.menuElement.setCssStyles({
                left: `${anchorLeft}px`,
                top: `${anchorBottom + 6}px`
            });

            const popupRect = this.menuElement.getBoundingClientRect();
            let nextLeft = anchorLeft;
            let nextTop = anchorBottom + 6;
            if (nextTop + popupRect.height > window.innerHeight - margin) nextTop = anchorTop - popupRect.height - 6;
            if (nextTop < margin) nextTop = margin;
            if (nextTop + popupRect.height > window.innerHeight - margin) nextTop = Math.max(margin, window.innerHeight - popupRect.height - margin);
            if (nextLeft + popupRect.width > window.innerWidth - margin) nextLeft = window.innerWidth - popupRect.width - margin;
            if (nextLeft < margin) nextLeft = margin;

            this.menuElement.setCssStyles({
                left: `${Math.round(nextLeft)}px`,
                top: `${Math.round(nextTop)}px`
            });
            if (Date.now() >= 0) return;
            if (false) {
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
                    this.menuElement.setCssStyles({
                        left: `${rect.left}px`,
                        top: `${rect.bottom + 5}px`
                    });
                } else {
                    const rect = editorEl.getBoundingClientRect();
                    this.menuElement.setCssStyles({
                        left: `${rect.left}px`,
                        top: `${rect.bottom + 5}px`
                    });
                }
            }

            var rect = this.menuElement.getBoundingClientRect();
            var winHeight = window.innerHeight;
            var winWidth = window.innerWidth;

            if (rect.bottom > winHeight) {
                var top = rect.top;
                this.menuElement.setCssStyles({ top: `${top - rect.height - 40}px` });
            }
            if (rect.right > winWidth) {
                this.menuElement.setCssStyles({ left: `${winWidth - rect.width - 10}px` });
            }
            if (rect.left < 10) {
                this.menuElement.setCssStyles({ left: "10px" });
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
                    const parsed = parseTaskLine(line);
                    if (parsed && parsed.didaId) {
                        const didaId = parsed.didaId;
                        const status = parsed.checkbox === "x" ? 2 : 0;
                        let title = parsed.title;
                        const dateRegex = /^(\s*)-\s\[[ x]\]\s*(.+)📅\s*(\d{4}-\d{2}-\d{2})(.*)$/;
                        const dateMatch = line.match(dateRegex);
                        const newTitle = title;
                        const parsedDateMatch = parsed.dueDate ? parsed.dueDate.match(/(\d{4}-\d{2}-\d{2})/) : null;
                        const newDate = parsedDateMatch ? parsedDateMatch[1] : (dateMatch ? dateMatch[3] : null);
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
                    const parsed = parseTaskLine(line);
                    if (parsed && parsed.didaId) {
                        return { didaId: parsed.didaId, title: parsed.title, line: lineNumber };
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
        this.resetMenuVariantClasses();
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
            this.renderScheduleMenu();
        });
        this.menuItems.push(dateOption);

        const priorityOption = optionsDiv.createEl("div", { cls: "task-action-menu-option", text: "🔴 优先级" });
        priorityOption.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.renderPriorityMenu();
        });
        this.menuItems.push(priorityOption);

        const repeatOption = optionsDiv.createEl("div", { cls: "task-action-menu-option", text: "🔁 重复" });
        repeatOption.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.renderRepeatMenu();
        });
        this.menuItems.push(repeatOption);

        this.updateSelectedItem();
        this.positionMenu();
    }

    renderScheduleMenu() {
        if (!this.menuElement) return;

        const line = this.editor?.getLine(this.cursor?.line || 0) || "";
        const parsed = parseTaskLine(line);

        this.menuElement.empty();
        this.resetMenuVariantClasses();
        this.menuElement.addClass("task-action-menu-with-calendar");
        this.selectedIndex = 0;
        this.menuItems = [];

        this.menuElement.createEl("div", { cls: "task-action-menu-title" }).textContent = "到期/时间段";
        this.renderBackButton();

        const body = this.menuElement.createDiv("dida-task-action-schedule-body");
        const picker = new TaskSchedulePicker(this.app, {
            startDate: parsed?.startDate || null,
            dueDate: parsed?.dueDate || null,
            isAllDay: typeof parsed?.isAllDay === "boolean" ? parsed.isAllDay : true,
            repeatFlag: parsed?.repeatFlag || null,
            isScheduled: !!(parsed?.startDate || parsed?.dueDate)
        });
        picker.render(body);
        picker.renderActions(body, {
            primaryLabel: "确认",
            onCancel: () => {
                this.renderMainMenu();
                return false;
            },
            onSubmit: async value => {
                this.close();
                this.onAction("date", {
                    startDate: value.startDate,
                    dueDate: value.dueDate || value.startDate,
                    isAllDay: value.isAllDay,
                    repeatFlag: value.repeatFlag ?? null
                });
            }
        });

        const actionButtons = Array.from(body.querySelectorAll(".dida-task-schedule-actions button")) as HTMLElement[];
        this.menuItems.push(...actionButtons);
        this.updateSelectedItem();
        this.positionMenu();
    }

    renderPriorityMenu() {
        if (!this.menuElement) return;
        this.menuElement.empty();
        this.resetMenuVariantClasses();
        this.selectedIndex = 0;
        this.menuItems = [];
        this.menuElement.createEl("div", { cls: "task-action-menu-title" }).textContent = "选择优先级";
        this.renderBackButton();
        [
            { label: "⚪ 无优先级", priority: 0 },
            { label: "🔵 低优先级", priority: 1 },
            { label: "🟡 中优先级", priority: 3 },
            { label: "🔴 高优先级", priority: 5 }
        ].forEach(item => {
            const el = this.menuElement!.createEl("div", { cls: "task-action-menu-option", text: item.label });
            el.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                this.close();
                this.onAction("priority", { priority: item.priority });
            });
            this.menuItems.push(el);
        });
        this.updateSelectedItem();
        this.positionMenu();
    }

    renderRepeatMenu() {
        if (!this.menuElement) return;
        this.menuElement.empty();
        this.resetMenuVariantClasses();
        this.selectedIndex = 0;
        this.menuItems = [];
        this.menuElement.createEl("div", { cls: "task-action-menu-title" }).textContent = "选择重复";
        this.renderBackButton();
        [
            { label: "不重复", text: "" },
            { label: "每天", text: "every day" },
            { label: "每周", text: "every week" },
            { label: "每月", text: "every month" },
            { label: "每年", text: "every year" }
        ].forEach(item => {
            const el = this.menuElement!.createEl("div", { cls: "task-action-menu-option", text: item.label });
            el.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                this.close();
                this.onAction("repeat", { repeatFlag: item.text ? tasksRepeatToRRule(item.text) : null });
            });
            this.menuItems.push(el);
        });
        this.updateSelectedItem();
        this.positionMenu();
    }

    renderBackButton() {
        if (!this.menuElement) return;
        const backBtn = this.menuElement.createEl("div", { cls: "task-action-menu-back", text: "← 返回" });
        backBtn.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.renderMainMenu();
        });
        this.menuItems.push(backBtn);
    }

    renderSearchMenu() {
        if (!this.menuElement || !this.editor || !this.cursor) return;

        this.menuElement.empty();
        this.resetMenuVariantClasses();
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
            attr: { placeholder: "搜索任务..." }
        });
        searchInput.focus();

        const resultsContainer = this.menuElement.createEl("div", { cls: "dida-suggestions-container" });

        const tasks = (this.plugin.settings.tasks || []).filter(t => {
            if (this.plugin.isTaskListItem && !this.plugin.isTaskListItem(t)) return false;
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
            this.positionMenu();
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
