import { RRuleParser } from "../core/RRuleParser";
import { DidaTask } from "../types";
import DidaSyncPlugin from "../main";

export class RepeatTaskManager {
    plugin: DidaSyncPlugin;

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
    }

    async createRepeatTaskCopy(task: DidaTask): Promise<DidaTask | null> {
        if (!RRuleParser.hasRepeatRule(task)) return null;
        try {
            var nextDueDate = RRuleParser.calculateNextDueDate(task.repeatFlag!, task.dueDate!);
            if (!nextDueDate) return null;
            
            let nextStartDate: string | null = null;
            var nextDate = new Date(nextDueDate);
            
            if (task.startDate && task.dueDate) {
                try {
                    var start = new Date(task.startDate),
                        due = new Date(task.dueDate),
                        duration = Math.max(0, due.getTime() - start.getTime()),
                        newStart = new Date(nextDate.getTime() - duration);
                    nextStartDate = newStart.toISOString();
                } catch (t) {
                    nextStartDate = nextDueDate;
                }
            } else if (task.startDate) {
                try {
                    var start = new Date(task.startDate),
                        due = task.dueDate ? new Date(task.dueDate) : start,
                        diff = start.getTime() - due.getTime(),
                        newStart = new Date(nextDate.getTime() + diff);
                    nextStartDate = newStart.toISOString();
                } catch (t) {
                    nextStartDate = nextDueDate;
                }
            } else {
                nextStartDate = nextDueDate;
            }

            let newTask: DidaTask = {
                ...task,
                id: this.generateTaskId(),
                didaId: undefined,
                status: 0,
                completedTime: undefined,
                dueDate: nextDueDate,
                startDate: nextStartDate || undefined,
                createdAt: (new Date).toISOString(),
                updatedAt: (new Date).toISOString(),
                etag: undefined
            };

            delete newTask.completedTime;
            newTask.status = 0;

            var subtasks = this.plugin.settings.tasks.filter(t => t.parentId === task.didaId);
            
            if (task.items && 0 < task.items.length) {
                newTask.items = task.items.map(t => ({
                    ...t,
                    id: this.generateItemId(),
                    status: 0,
                    completedTime: undefined
                }));
            } else {
                newTask.items = [];
            }

            if (0 < subtasks.length) {
                this.plugin.settings.tasks.push(newTask);
                await this.plugin.saveSettings();
                
                for (var sub of subtasks) {
                    var newSub: DidaTask = {
                        ...sub,
                        id: this.generateTaskId(),
                        didaId: null as any,
                        status: 0,
                        completedTime: null as any,
                        parentId: null,
                        createdAt: (new Date).toISOString(),
                        updatedAt: (new Date).toISOString(),
                        etag: null as any
                    };
                    this.plugin.settings.tasks.push(newSub);
                }
                await this.plugin.saveSettings();

                if (this.plugin.settings.accessToken) {
                    setTimeout(async () => {
                        try {
                            await this.plugin.createTaskInDidaList(newTask);
                            setTimeout(async () => {
                                const created = this.plugin.settings.tasks.find(t => t.id === newTask.id);
                                if (created && created.didaId) {
                                    for (let subTask of this.plugin.settings.tasks.filter(t => subtasks.some(st => st.title === t.title && t.parentId == null && t.id !== newTask.id))) {
                                        subTask.parentId = created.didaId;
                                        await this.plugin.createTaskInDidaList(subTask);
                                    }
                                    await this.plugin.saveSettings();
                                    this.plugin.refreshTaskView();
                                }
                            }, 500);
                        } catch (t) {}
                    }, 100);
                }
            } else {
                this.plugin.settings.tasks.push(newTask);
                await this.plugin.saveSettings();
                if (this.plugin.settings.accessToken) {
                    setTimeout(async () => {
                        try {
                            await this.plugin.createTaskInDidaList(newTask);
                            this.plugin.refreshTaskView();
                        } catch (t) {}
                    }, 100);
                }
            }
            return newTask;
        } catch (t) {
            return null;
        }
    }

    generateTaskId(): string {
        return Date.now().toString() + Math.random().toString(36).substr(2, 9);
    }

    generateItemId(): string {
        return Math.random().toString(36).substr(2, 24);
    }
}
