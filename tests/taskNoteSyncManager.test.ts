import assert from "node:assert/strict";
import Module from "node:module";

const notices: string[] = [];
const originalLoad = (Module as any)._load;
class MockTFile {
    path: string;
    basename: string;
    extension: string;
    constructor(path = "Daily.md") {
        this.path = path;
        this.basename = path.replace(/\.md$/, "");
        this.extension = "md";
    }
}
const obsidianMock = {
    Notice: class Notice {
        constructor(message?: string) { if (message) notices.push(message); }
    },
    TFile: MockTFile,
    normalizePath: (value: string) => value.replace(/\/+/g, "/")
};
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "obsidian") {
        return obsidianMock;
    }
    if (request === "../main" || request.endsWith("/main")) {
        return class DidaSyncPlugin { };
    }
    return originalLoad.call(this, request, parent, isMain);
};

async function run() {
    const { TaskNoteSyncManager } = require("../src/managers/TaskNoteSyncManager");
    const { TFile } = require("obsidian");
    const file = new TFile("DidaSync/2026-06-24.md");
    const vaultData = new Map<string, string>([[file.path, "# Day\n"]]);
    const abstractFiles = new Map<string, any>([[file.path, file]]);
    const createdFolders: string[] = [];
    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => abstractFiles.get(path) || null,
            createFolder: async (path: string) => {
                createdFolders.push(path);
                abstractFiles.set(path, { path, children: [] });
            },
            create: async (path: string, content: string) => {
                const created = new TFile(path);
                vaultData.set(path, content);
                abstractFiles.set(path, created);
                return created;
            },
            read: async (target: any) => vaultData.get(target.path) || "",
            cachedRead: async (target: any) => vaultData.get(target.path) || "",
            modify: async (target: any, content: string) => vaultData.set(target.path, content),
            process: async (target: any, cb: (data: string) => string) => {
                vaultData.set(target.path, cb(vaultData.get(target.path) || ""));
            }
        },
        metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
        workspace: { getLeaf: () => ({ openFile: async () => { } }) }
    };
    const plugin = {
        settings: {
            accessToken: "",
            tasks: [
                { id: "1", didaId: "r1", title: "Alpha", status: 0, projectId: "inbox", projectName: "收集箱", dueDate: "2026-06-24T00:00:00+0800", isAllDay: true },
                { id: "2", didaId: "r2", title: "Beta", status: 0, projectId: "p1", projectName: "项目甲", dueDate: "2026-06-25T09:00:00+0800", startDate: "2026-06-25T08:00:00+0800", isAllDay: false },
                { id: "3", didaId: "r3", title: "Gamma", status: 0, projectId: "p2", projectName: "项目乙", dueDate: "2026-06-26T00:00:00+0800", isAllDay: true }
            ],
            taskNoteSyncUseRemoteQuery: false,
            taskNoteSyncTargetBlockHeader: "> [!todo]",
            taskNoteSyncFolder: "DidaSync",
            taskNoteSyncWeekStart: "monday",
            taskNoteSyncPathPatterns: { day: "", week: "", month: "", year: "" }
        },
        resolveTaskProjectInfo(task: any) { return { id: task.projectId, name: task.projectName }; },
        getProjectFilterKeyAliases(id: string, name: string) { return [`id:${id}`, `name:${name}`]; },
        formatDidaDateTime(date: Date) { return date.toISOString(); },
        normalizeRemoteTask(task: any) { return task; },
        apiClient: { filterTasks: async () => [] }
    };
    const manager = new TaskNoteSyncManager(app as any, plugin as any);

    const mobileFile = await manager.ensureMarkdownFile("Mobile/Nested.md", "# Mobile\n");
    assert.equal(mobileFile.path, "Mobile/Nested.md");
    assert.deepEqual(createdFolders, ["Mobile"]);

    assert.deepEqual(manager.createRange("week", "2026-06-24"), { type: "week", startDate: "2026-06-22", endDate: "2026-06-28" });
    assert.deepEqual(manager.createRange("custom", "2026-06-26", "2026-06-24"), { type: "custom", startDate: "2026-06-24", endDate: "2026-06-26" });

    const selected = await manager.getTasksForRange(
        { type: "custom", startDate: "2026-06-24", endDate: "2026-06-26" },
        ["id:p1"],
        "custom"
    );
    assert.deepEqual(selected.map((task: any) => task.title), ["Beta"]);

    await manager.smartAppendTasksToHeader(
        file,
        "> [!todo]",
        selected,
        { type: "custom", startDate: "2026-06-24", endDate: "2026-06-26" },
        true
    );
    const written = vaultData.get(file.path) || "";
    assert.match(written, /> \[!todo\]/);
    assert.match(written, /> ### 2026-06-25/);
    assert.match(written, /> - \[ \] Beta/);

    await manager.saveDidaBlockConfigInFile(file, {
        header: "> [!didasync]",
        config: { range: "2026-06-24~2026-06-25", projects: ["id:p1"] }
    });
    const analysis = await manager.analyzeDidaBlocksInFile(file);
    assert.equal(analysis?.totalBlocks, 1);
    assert.equal(analysis?.validBlocks, 1);
    assert.equal(analysis?.items[0].projectsText, "id:p1");

    await manager.syncDidaBlocksInFile(file);
    const syncedBlock = vaultData.get(file.path) || "";
    assert.match(syncedBlock, /<!-- didasync:start -->/);
    assert.match(syncedBlock, /Beta/);

    let remoteFilters: any = null;
    plugin.settings.accessToken = "token";
    plugin.settings.taskNoteSyncUseRemoteQuery = true;
    plugin.apiClient.filterTasks = async (filters: any) => {
        remoteFilters = filters;
        return [{ id: "r-completed", title: "Remote completed", status: 2, projectId: "p1", projectName: "项目甲", dueDate: "2026-06-25T10:00:00+0800" }];
    };
    const remoteSelected = await manager.getTasksForRange(
        { type: "day", startDate: "2026-06-25", endDate: "2026-06-25" }
    );
    assert.deepEqual(remoteFilters.status, [0, 2]);
    assert.deepEqual(remoteSelected.map((task: any) => task.title), ["Beta", "Remote completed"]);

    console.log("TaskNoteSyncManager tests passed");
}

run()
    .finally(() => {
        (Module as any)._load = originalLoad;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
