import { App, Editor, EditorPosition } from 'obsidian';
import DidaSyncPlugin from '../main';
import { DidaTask } from '../types';

export class TaskSuggestionPopup {
    app: App;
    plugin: DidaSyncPlugin;
    editor: Editor;
    cursor: EditorPosition;
    onSelect: (task: DidaTask) => void;
    filteredTasks: DidaTask[];
    selectedIndex: number;
    searchTerm: string;
    element: HTMLElement | null;

    constructor(app: App, plugin: DidaSyncPlugin, editor: Editor, cursor: EditorPosition, onSelect: (task: DidaTask) => void) {
        this.app = app;
        this.plugin = plugin;
        this.editor = editor;
        this.cursor = cursor;
        this.onSelect = onSelect;
        this.filteredTasks = [];
        this.selectedIndex = 0;
        this.searchTerm = "";
        this.element = null;
        this.open();
    }

    open() {
        this.element = document.createElement("div");
        this.element.className = "dida-task-suggestion-popup";
        this.searchTerm = "";
        this.filterTasks();
        this.renderSuggestions();
        this.setupEventListeners();
        document.body.appendChild(this.element);
    }

    getFilteredTasks() {
        return (this.plugin.settings.tasks || []).filter(t => {
            if (t.parentId) return false;
            
            const isCompleted = t.completed === true || t.completed === 2 || t.status === 2;
            const isArchived = t.projectClosed === true;
            
            if (isCompleted) return false;
            if (!this.plugin.settings.showArchivedProjects && isArchived) return false;
            
            return true;
        });
    }

    renderSuggestions() {
        if (!this.element) return;
        this.element.innerHTML = "";
        
        const searchContainer = document.createElement("div");
        searchContainer.className = "dida-search-container";
        
        const input = document.createElement("input");
        input.type = "text";
        input.className = "dida-search-input";
        input.placeholder = "搜索任务或输入新任务标题（Enter确认）...";
        input.value = this.searchTerm;
        
        let isComposing = false;
        input.addEventListener("compositionstart", () => {
            isComposing = true;
        });
        
        input.addEventListener("compositionend", () => {
            isComposing = false;
            this.searchTerm = input.value;
            this.filterTasks();
            this.renderSuggestions();
        });
        
        input.addEventListener("input", (e: any) => {
            this.searchTerm = e.target.value;
            if (!isComposing) {
                this.filterTasks();
                this.renderSuggestions();
            }
        });
        
        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                this.close();
            }
        });
        
        searchContainer.appendChild(input);
        this.element.appendChild(searchContainer);
        
        setTimeout(() => input.focus(), 10);
        
        if (this.searchTerm) {
            const hint = document.createElement("div");
            hint.className = "dida-search-hint";
            hint.textContent = `搜索结果: ${this.filteredTasks.length} 个任务`;
            this.element.appendChild(hint);
        }
        
        if (this.filteredTasks.length === 0) {
            const noTasks = document.createElement("div");
            noTasks.className = "dida-no-tasks";
            noTasks.textContent = this.searchTerm ? "没有找到匹配的任务，按Enter创建新任务" : "没有找到任务";
            this.element.appendChild(noTasks);
        } else {
            const suggestionsContainer = document.createElement("div");
            suggestionsContainer.className = "dida-suggestions-container";
            this.element.appendChild(suggestionsContainer);
            
            this.filteredTasks.forEach((task, index) => {
                const item = document.createElement("div");
                item.className = "dida-suggestion-item " + (index === this.selectedIndex ? "selected" : "");
                item.setAttribute("data-index", index.toString());
                
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
                
                suggestionsContainer.appendChild(item);
            });
        }
    }

    setupEventListeners() {
        if (!this.element) return;
        
        this.element.addEventListener("keydown", (e) => {
            const target = e.target as HTMLElement;
            if (target.classList.contains("dida-search-input")) {
                switch (e.key) {
                    case "ArrowDown":
                        e.preventDefault();
                        if (this.filteredTasks.length > 0) {
                            this.selectedIndex = this.selectedIndex < 0 ? 0 : Math.min(this.selectedIndex + 1, this.filteredTasks.length - 1);
                            this.renderSuggestions();
                        }
                        break;
                    case "ArrowUp":
                        e.preventDefault();
                        if (this.filteredTasks.length > 0) {
                            this.selectedIndex = this.selectedIndex < 0 ? this.filteredTasks.length - 1 : Math.max(this.selectedIndex - 1, 0);
                            this.renderSuggestions();
                        }
                        break;
                    case "Enter":
                        e.preventDefault();
                        if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredTasks.length) {
                            this.selectTask();
                        } else if (this.searchTerm.trim()) {
                            this.createNewTask(this.searchTerm.trim());
                        }
                        break;
                }
            } else {
                switch (e.key) {
                    case "ArrowDown":
                        e.preventDefault();
                        if (this.filteredTasks.length > 0) {
                            this.selectedIndex = this.selectedIndex < 0 ? 0 : Math.min(this.selectedIndex + 1, this.filteredTasks.length - 1);
                            this.renderSuggestions();
                        }
                        break;
                    case "ArrowUp":
                        e.preventDefault();
                        if (this.filteredTasks.length > 0) {
                            this.selectedIndex = this.selectedIndex < 0 ? this.filteredTasks.length - 1 : Math.max(this.selectedIndex - 1, 0);
                            this.renderSuggestions();
                        }
                        break;
                    case "Enter":
                        e.preventDefault();
                        if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredTasks.length) {
                            this.selectTask();
                        } else if (this.searchTerm.trim()) {
                            this.createNewTask(this.searchTerm.trim());
                        }
                        break;
                    case "Escape":
                        e.preventDefault();
                        this.close();
                        break;
                    case "Backspace":
                        if (this.searchTerm === "") {
                            e.preventDefault();
                            this.close();
                        }
                        break;
                    default:
                        if (e.key.length === 1) {
                            this.searchTerm += e.key;
                            this.filterTasks();
                            this.renderSuggestions();
                        }
                }
            }
        });

        this.element.addEventListener("click", (e) => {
            const item = (e.target as HTMLElement).closest(".dida-suggestion-item");
            if (item) {
                const idx = item.getAttribute("data-index");
                if (idx !== null) {
                    this.selectedIndex = parseInt(idx);
                    this.selectTask();
                }
            }
        });

        document.addEventListener("click", this.handleOutsideClick);
    }

    handleOutsideClick = (e: MouseEvent) => {
        if (this.element && !this.element.contains(e.target as Node)) {
            this.close();
        }
    }

    filterTasks() {
        let tasks = this.getFilteredTasks();
        if (this.searchTerm) {
            tasks = tasks.filter(t => {
                const titleMatch = t.title && t.title.toLowerCase().includes(this.searchTerm.toLowerCase());
                const projectMatch = t.projectName && t.projectName.toLowerCase().includes(this.searchTerm.toLowerCase());
                return titleMatch || projectMatch;
            }).sort((a, b) => {
                const dateA = new Date(a.updatedAt || a.createdAt).getTime();
                const dateB = new Date(b.updatedAt || b.createdAt).getTime();
                return dateB - dateA;
            });
        } else {
            tasks = tasks.sort((a, b) => {
                const dateA = new Date(a.updatedAt || a.createdAt).getTime();
                const dateB = new Date(b.updatedAt || b.createdAt).getTime();
                return dateB - dateA;
            });
        }
        this.filteredTasks = tasks;
        this.selectedIndex = -1;
    }

    selectTask() {
        if (this.filteredTasks.length > 0 && this.selectedIndex >= 0 && this.selectedIndex < this.filteredTasks.length) {
            const task = this.filteredTasks[this.selectedIndex];
            if (this.onSelect) {
                this.onSelect(task);
            }
        }
        this.close();
    }

    async createNewTask(title: string) {
        this.close();
        try {
            const task = await this.plugin.addTask(title, "收集箱", "inbox");
            // If addTask returns a task, we use it.
            // But plugin.addTask logic might handle the rest.
            // The original code calls insertTaskLink.
            
            // Wait, addTask returns the created task?
            // In original code: `let e = await this.plugin.addTask(t, "收集箱", "inbox");`
            
            // Then find it in settings to ensure we have latest or use returned
            const found = this.plugin.settings.tasks.find(t => t.id === task.id);
            const taskToUse = found && found.didaId ? found : { ...found || task, didaId: found?.id || task.id };
            
            // Wait, if it's local only, didaId might be null or same as id?
            // Original code: `a && a.didaId ? this.plugin.insertTaskLink(...) : (i = {...}, this.plugin.insertTaskLink(...))`
            
            this.plugin.insertTaskLink(this.editor, this.cursor, taskToUse);
        } catch (e) {
            console.error(e);
        }
    }

    close() {
        if (this.element) {
            document.removeEventListener("click", this.handleOutsideClick);
            if (this.element.parentElement) {
                this.element.parentElement.removeChild(this.element);
            }
            this.element = null;
        }
    }
}
