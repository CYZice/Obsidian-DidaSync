import { Modal, App, Notice } from 'obsidian';
import DidaSyncPlugin from '../main';
import { DatePickerModal } from './DatePickerModal';
import { DidaTask } from '../types';

export class AddTaskToProjectModal extends Modal {
    plugin: DidaSyncPlugin;
    selectedDate: Date | null;
    selectedEndDate: Date | null;
    isAllDay: boolean;

    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app);
        this.plugin = plugin;
        this.selectedDate = null;
        this.selectedEndDate = null;
        this.isAllDay = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "在项目中添加任务" });

        const projects = this.getAvailableProjects();
        if (projects.length === 0) {
            contentEl.createEl("p", {
                text: "没有可用的项目，请先同步或创建项目",
                cls: "dida-empty-state"
            });
        } else {
            const formDiv = contentEl.createDiv();
            formDiv.style.cssText = "display: flex; gap: 15px; margin: 20px 0; align-items: flex-end;";
            
            const projectGroup = formDiv.createDiv();
            projectGroup.style.cssText = "flex: 1;";
            projectGroup.createEl("label", { text: "选择项目：" });
            
            const projectSelect = projectGroup.createEl("select", { cls: "dida-project-select" });
            projectSelect.style.cssText = "width: 100%; margin-top: 5px;";
            projects.forEach(p => {
                projectSelect.createEl("option", {
                    value: JSON.stringify(p),
                    text: p.name
                });
            });

            const dateBtn = formDiv.createEl("button", {
                text: "📅",
                cls: "dida-date-btn"
            });
            dateBtn.style.cssText = "width: 32px; height: 32px; border: 1px solid var(--background-modifier-border); border-radius: 4px; background: var(--background-primary); color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;";
            
            const dateDisplay = formDiv.createEl("span", {
                text: "未设置",
                cls: "dida-date-display"
            });
            dateDisplay.style.cssText = "flex: 1; padding: 6px 8px; border: 1px solid var(--background-modifier-border); border-radius: 4px; background: var(--background-primary); color: var(--text-muted); font-size: 12px; display: flex; align-items: center;";

            const titleGroup = contentEl.createDiv();
            titleGroup.style.cssText = "margin: 20px 0;";
            titleGroup.createEl("label", { text: "任务标题：" });
            const titleInput = titleGroup.createEl("input", {
                type: "text",
                placeholder: "请输入任务标题",
                cls: "dida-task-title-input"
            });
            titleInput.style.cssText = "width: 100%; margin-top: 5px;";

            dateBtn.onclick = (e) => {
                new DatePickerModal(this.app, this.selectedDate || new Date(), (date, isAllDay, endDate) => {
                    this.selectedDate = date;
                    this.selectedEndDate = endDate || null;
                    this.isAllDay = isAllDay;
                    
                    if (this.selectedDate) {
                        const dateStr = this.selectedDate.toLocaleDateString("zh-CN");
                        if (isAllDay) {
                            dateDisplay.textContent = dateStr + " 全天";
                        } else {
                            const timeStr = this.selectedDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                            const endTimeStr = (this.selectedEndDate || this.selectedDate).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                            dateDisplay.textContent = dateStr + ` ${timeStr}～` + endTimeStr;
                        }
                        dateDisplay.style.color = "var(--text-normal)";
                    } else {
                        dateDisplay.textContent = "未设置";
                        dateDisplay.style.color = "var(--text-muted)";
                    }
                }, e.currentTarget as HTMLElement, null, undefined).open();
            };

            const btnContainer = contentEl.createDiv();
            btnContainer.style.cssText = "text-align: right; margin-top: 20px;";
            
            btnContainer.createEl("button", { text: "取消" }).onclick = () => this.close();
            
            const submitBtn = btnContainer.createEl("button", {
                text: "添加任务",
                cls: "mod-cta"
            });
            submitBtn.style.marginLeft = "10px";
            
            submitBtn.onclick = async () => {
                const project = JSON.parse(projectSelect.value);
                const title = titleInput.value.trim();
                
                if (title) {
                    let startDate: string | null = null;
                    let dueDate: string | null = null;
                    
                    if (this.selectedDate) {
                        startDate = this.selectedDate.toISOString();
                        dueDate = this.isAllDay ? startDate : (this.selectedEndDate || this.selectedDate).toISOString();
                    }
                    
                    const newTask: DidaTask = {
                        id: Date.now().toString(),
                        title: title,
                        content: "",
                        completed: false,
                        status: 0,
                        completedTime: null,
                        didaId: null,
                        projectId: project.id,
                        projectName: project.name,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        startDate: startDate,
                        dueDate: dueDate,
                        isAllDay: this.isAllDay || false,
                        items: [],
                        kind: "TEXT",
                        priority: 0,
                        sortOrder: 0,
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        isFloating: false
                    };
                    
                    this.plugin.settings.tasks = this.plugin.settings.tasks || [];
                    this.plugin.settings.tasks.push(newTask);
                    await this.plugin.saveSettings();
                    this.plugin.refreshTaskView();
                    
                    // Trigger refresh on time block view if open? 
                    // Source used document.querySelector logic
                    const selectedTimelineDate = document.querySelector(".dida-timeline-date-item.dida-timeline-selected") as HTMLElement;
                    if (selectedTimelineDate) selectedTimelineDate.click();

                    if (this.plugin.settings.accessToken) {
                        try {
                            await this.plugin.createTaskInDidaList(newTask);
                            this.plugin.refreshTaskView();
                            if (selectedTimelineDate) selectedTimelineDate.click();
                        } catch (e) {
                            this.plugin.refreshTaskView();
                            if (selectedTimelineDate) selectedTimelineDate.click();
                        }
                    }
                    this.close();
                } else {
                    new Notice("请输入任务标题");
                }
            };

            titleInput.addEventListener("keypress", (e) => {
                if (e.key === "Enter") submitBtn.click();
            });

            setTimeout(() => titleInput.focus(), 100);
        }
    }

    onClose() {
        this.contentEl.empty();
    }

    getAvailableProjects() {
        const projects = [];
        projects.push({ id: "inbox", name: "收集箱" });
        
        const tasks = this.plugin.settings.tasks || [];
        const projectMap = new Map<string, { id: string, name: string }>();
        
        tasks.forEach(t => {
            if (t.projectName && t.projectId) {
                const key = t.projectId + "-" + t.projectName;
                if (!projectMap.has(key)) {
                    projectMap.set(key, { id: t.projectId, name: t.projectName });
                }
            }
        });
        
        projectMap.forEach(p => {
            if (p.id !== "inbox" && p.name !== "收集箱") {
                projects.push(p);
            }
        });
        
        projects.sort((a, b) => {
            if (a.name === "收集箱") return -1;
            if (b.name === "收集箱") return 1;
            return a.name.localeCompare(b.name);
        });
        
        return projects;
    }
}
