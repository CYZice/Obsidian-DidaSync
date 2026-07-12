import assert from "node:assert/strict";
import Module from "node:module";

const originalLoad = (Module as any)._load;
class BaseView {
    containerEl: any;
    constructor() {
        this.containerEl = { children: [{}, {}] };
    }
}

const obsidianMock = {
    App: BaseView,
    ItemView: BaseView,
    WorkspaceLeaf: BaseView,
    Notice: class { },
    setIcon: () => { }
};

(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "obsidian") return obsidianMock;
    return originalLoad.call(this, request, parent, isMain);
};

async function run() {
    try {
        const { TimelineViewModal } = require("../src/modals/TimelineViewModal");
        const { TaskView } = require("../src/views/TaskView");

        const tasks = [
            {
                id: "parent",
                didaId: "parent",
                title: "父任务",
                status: 0,
                projectId: "p1",
                projectName: "项目",
                dueDate: "2026-06-26T09:00:00.000Z"
            },
            {
                id: "child",
                didaId: "child",
                title: "子任务",
                status: 0,
                parentId: "parent",
                projectId: "p1",
                projectName: "项目",
                dueDate: "2026-06-26T10:00:00.000Z"
            },
            {
                id: "other",
                didaId: "other",
                title: "其他日期任务",
                status: 0,
                projectId: "p1",
                projectName: "项目",
                dueDate: "2026-06-27T10:00:00.000Z"
            }
        ];

        const plugin = {
            settings: {
                tasks,
                completedTasks: [
                    {
                        id: "done-child",
                        didaId: "done-child",
                        title: "已完成子任务",
                        status: 2,
                        parentId: "parent",
                        projectId: "p1",
                        projectName: "项目",
                        completedTime: "2026-06-26T12:00:00.000Z"
                    }
                ],
                defaultCalendarMode: "day",
                defaultShowCompletedInCalendar: true,
                showArchivedProjects: true,
                timeBlockStartHour: 0,
                pomodoroSettings: {}
            },
            resolveTaskProjectInfo(task: any) {
                return {
                    id: task.projectId || "inbox",
                    name: task.projectName || "收集箱",
                    isArchived: false,
                    isLocalOnly: false
                };
            },
            buildDefaultCompletedTaskQuery() {
                return {};
            },
            isNoteSyncTaskLike(task: any) {
                if (!task || typeof task !== "object") return false;
                if (task.kind === "NOTE" || task.projectKind === "NOTE") return true;
                if (typeof task.projectViewMode === "string" && task.projectViewMode.trim().toLowerCase() === "note") return true;
                return false;
            },
            isTaskListItem(task: any) {
                return !this.isNoteSyncTaskLike(task);
            },
            isProjectVisible() {
                return true;
            }
        };

        const timeline = new TimelineViewModal({} as any, plugin as any);
        const timelineTasks = timeline.getTasksForDate(new Date("2026-06-26T00:00:00.000Z"));
        assert.deepEqual(timelineTasks.map((task: any) => task.id), ["parent", "child"]);

        const taskView = new TaskView({} as any, plugin as any);
        taskView.searchQuery = "";
        taskView.dateFilter = null;
        assert.equal((taskView as any).hasActiveTaskFilter(), false);
        taskView.dateFilter = "today";
        assert.equal((taskView as any).hasActiveTaskFilter(), true);

        taskView.calendarDisplayDate = new Date("2026-06-26T00:00:00.000Z");
        const grouped = taskView.getCalendarTasksForRange({
            startDate: new Date("2026-06-01T00:00:00.000Z"),
            endDate: new Date("2026-06-30T23:59:59.999Z")
        } as any);

        const pending = grouped.pending.get("2026-06-26") || [];
        const completed = grouped.completed.get("2026-06-26") || [];
        assert.ok(pending.some((task: any) => task.id === "child"));
        assert.ok(completed.some((task: any) => task.id === "done-child"));

        console.log("Date view subtask tests passed");
    } finally {
        (Module as any)._load = originalLoad;
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
