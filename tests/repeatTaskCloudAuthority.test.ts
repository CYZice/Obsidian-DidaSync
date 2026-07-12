import assert from "node:assert/strict";
import Module from "node:module";

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "obsidian") {
        return {
            Notice: class Notice {
                constructor(_message?: string) { }
            }
        };
    }
    if (request === "../main" || request.endsWith("/main")) {
        return class DidaSyncPlugin { };
    }
    if (request === "../views/TaskView" || request.endsWith("/views/TaskView")) {
        return {
            TASK_VIEW_TYPE: "dida-task-view",
            TaskView: class TaskView { }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

async function run() {
    const { SyncManager } = require("../src/managers/SyncManager");
    const pluginClassifiers = {
        isNoteProjectLike(project: any) {
            const kind = typeof project?.kind === "string" ? project.kind.trim().toUpperCase() : "";
            const viewMode = typeof project?.viewMode === "string" ? project.viewMode.trim().toLowerCase() : "";
            return kind === "NOTE" || viewMode === "note";
        },
        isNoteSyncTaskLike(task: any) {
            if (!task || typeof task !== "object") return false;
            if (task.kind === "NOTE" || task.projectKind === "NOTE") return true;
            if (typeof task.projectViewMode === "string" && task.projectViewMode.trim().toLowerCase() === "note") return true;
            return false;
        },
        isTaskListItem(task: any) {
            return !this.isNoteSyncTaskLike(task);
        }
    };

    const localRepeatCopy = {
        id: "local-repeat-copy",
        title: "每日任务",
        content: "",
        desc: "",
        didaId: undefined,
        projectId: "inbox",
        dueDate: "2026-06-15T00:00:00+0800",
        startDate: "2026-06-15T00:00:00+0800",
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        status: 0,
        updatedAt: "2026-06-14T08:00:00+0800",
        items: []
    };

    const remoteRepeatTask = {
        id: "remote-repeat-next",
        title: "每日任务",
        content: "",
        desc: "",
        projectId: "inbox",
        dueDate: "2026-06-15T00:00:00+0800",
        startDate: "2026-06-15T00:00:00+0800",
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        status: 0,
        etag: "remote-etag",
        isAllDay: true,
        kind: "TEXT",
        reminders: [],
        priority: 0,
        createdTime: "2026-06-14T08:01:00+0800"
    };

    let saveCount = 0;
    const plugin = {
        settings: {
            tasks: [localRepeatCopy]
        },
        async saveSettings() {
            saveCount++;
        }
    };

    const manager = new SyncManager(plugin as any);
    const matchIndex = manager.findLocalRepeatTaskCopyIndex(remoteRepeatTask);
    assert.equal(matchIndex, 0, "remote repeat instance should match the old local optimistic copy");

    const merged = await manager.mergeRemoteRepeatTaskIntoLocalCopy(matchIndex, remoteRepeatTask, {
        id: "inbox",
        name: "收集箱"
    });

    assert.equal(plugin.settings.tasks.length, 1, "merge must not append a second task");
    assert.equal(merged.didaId, "remote-repeat-next");
    assert.equal(merged.etag, "remote-etag");
    assert.equal(merged.projectName, "收集箱");
    assert.equal(saveCount, 1, "merge should persist the remote id binding");

    const statuses: string[] = [];
    const syncPlugin = {
        settings: {
            accessToken: "access-token",
            tasks: [],
            reverseCompletionMeta: {},
            syncConsistencyMeta: {}
        },
        apiClient: {
            async makeAuthenticatedRequest() {
                return { ok: true, status: 200, async json() { return []; } };
            }
        },
        mergeRemoteProjectsIntoCatalog() {
            return false;
        },
        ...pluginClassifiers,
        updateStatusBar(status: string) {
            statuses.push(status);
        },
        refreshTaskView() { },
        async saveSettings() { },
        isReverseUpdating: false
    };
    const syncManager = new SyncManager(syncPlugin as any);

    await syncManager.syncFromDidaList();
    assert.deepEqual(statuses, ["同步中...", "已连接"], "a no-op sync should restore the connected status");
    assert.equal(syncManager.isSyncing, false, "a successful sync should release the sync lock");

    statuses.length = 0;
    let cleanupCalled = false;
    syncPlugin.apiClient.makeAuthenticatedRequest = async () => {
        return { ok: false, status: 503, async json() { return {}; } };
    };
    syncManager.syncDeletedTasks = async () => {
        cleanupCalled = true;
        return 0;
    };
    await syncManager.syncFromDidaList();
    assert.deepEqual(statuses, ["同步中...", "同步失败"], "failed remote pulls should expose the failure status");
    assert.equal(cleanupCalled, false, "failed remote pulls should not run missing-task cleanup");
    assert.equal(syncManager.isSyncing, false, "a failed sync should release the sync lock");

    const partialTask = {
        id: "local-b",
        didaId: "remote-b",
        title: "Keep me",
        content: "",
        status: 0,
        projectId: "b",
        updatedAt: "2026-06-20T00:00:00+0800"
    };
    const partialStatuses: string[] = [];
    const partialPlugin = {
        settings: { accessToken: "token", tasks: [partialTask], pendingSyncOperations: [], reverseCompletionMeta: {}, syncConsistencyMeta: {} },
        apiClient: {
            async makeAuthenticatedRequest(url: string) {
                if (url.endsWith("/project")) return { ok: true, status: 200, async json() { return [{ id: "a", name: "A" }, { id: "b", name: "B" }]; } };
                if (url.includes("/project/a/")) return { ok: true, status: 200, async json() { return []; } };
                if (url.includes("/project/b/")) return { ok: false, status: 503, async json() { return {}; } };
                if (url.includes("inbox") || url.endsWith("/task")) return { ok: true, status: 200, async json() { return []; } };
                return { ok: false, status: 503, async json() { return {}; } };
            }
        },
        mergeRemoteProjectsIntoCatalog() { return false; },
        ...pluginClassifiers,
        updateStatusBar(status: string) { partialStatuses.push(status); },
        refreshTaskView() { },
        async saveSettings() { },
        isReverseUpdating: false
    };
    const partialManager = new SyncManager(partialPlugin as any);
    const partialResult = await partialManager.syncFromDidaList();
    assert.equal(partialResult.outcome, "partial", "one failed project should make the sync partial");
    assert.equal(partialResult.cleanupPerformed, false, "partial snapshots must not run missing-task cleanup");
    assert.equal(partialTask.status, 0, "tasks from a failed project must remain unchanged");
    assert.equal(partialStatuses.at(-1), "部分同步失败");

    const dirtyTask = {
        id: "dirty-local",
        didaId: "dirty-remote",
        title: "Local pending title",
        content: "local",
        status: 0,
        projectId: "p1",
        updatedAt: "2026-06-24T00:00:00+0800"
    };
    let uploadShouldFail = true;
    const dirtyPlugin = {
        settings: { accessToken: "token", tasks: [dirtyTask], pendingSyncOperations: [], reverseCompletionMeta: {}, syncConsistencyMeta: {} },
        apiClient: {
            async makeAuthenticatedRequest(url: string) {
                if (uploadShouldFail) return { ok: false, status: 503, async json() { return {}; }, async text() { return "unavailable"; } };
                if (url.endsWith("/project")) return { ok: true, status: 200, async json() { return [{ id: "p1", name: "P1" }]; } };
                if (url.includes("/project/p1/")) return { ok: true, status: 200, async json() { return [{ id: "dirty-remote", title: "Remote old title", content: "", projectId: "p1", status: 0 }]; } };
                return { ok: true, status: 200, async json() { return []; } };
            }
        },
        mergeRemoteProjectsIntoCatalog() { return false; },
        ...pluginClassifiers,
        app: { workspace: { getLeavesOfType() { return []; } } },
        updateStatusBar() { },
        refreshTaskView() { },
        async saveSettings() { },
        isReverseUpdating: false
    };
    const dirtyManager = new SyncManager(dirtyPlugin as any);
    await assert.rejects(() => dirtyManager.updateTaskInDidaList(dirtyTask as any), /更新任务失败/);
    assert.equal(dirtyPlugin.settings.pendingSyncOperations.length, 1, "failed uploads must remain in the outbox");
    uploadShouldFail = false;
    await dirtyManager.syncFromDidaList();
    assert.equal(dirtyTask.title, "Local pending title", "remote pulls must not overwrite a task with pending local changes");
    await dirtyManager.updateTaskInDidaList(dirtyTask as any);
    assert.equal(dirtyPlugin.settings.pendingSyncOperations.length, 0, "successful uploads must clear the outbox");
    await dirtyManager.syncFromDidaList();
    assert.equal(dirtyTask.title, "Remote old title", "clean local tasks should accept remote edits");
    assert.equal(dirtyTask.content, "", "remote empty content should clear stale local content");

    const emptyResponsePlugin = {
        settings: { accessToken: "token", tasks: [], pendingSyncOperations: [], reverseCompletionMeta: {}, syncConsistencyMeta: {} },
        apiClient: {
            async makeAuthenticatedRequest() {
                return {
                    ok: true,
                    status: 200,
                    async text() { return ""; },
                    async json() { throw new Error("should not parse empty body"); }
                };
            }
        },
        mergeRemoteProjectsIntoCatalog() { return false; },
        app: { workspace: { getLeavesOfType() { return []; } } },
        updateStatusBar() { },
        refreshTaskView() { },
        async saveSettings() { },
        isReverseUpdating: false
    };
    const emptyResponseTask = { id: "t1", didaId: "r1", title: "Task", content: "", status: 0, projectId: "p1" };
    const emptyResponseManager = new SyncManager(emptyResponsePlugin as any);
    await emptyResponseManager.updateTaskInDidaList(emptyResponseTask as any);

    const placementTask = {
        id: "place-local",
        didaId: "place-remote",
        title: "Move me",
        content: "",
        status: 0,
        projectId: "p2",
        projectName: "P2",
        parentId: "parent-remote",
        updatedAt: "2026-06-24T00:00:00+0800",
        syncPlacementPending: true
    };
    let placementMoveCount = 0;
    const placementPlugin = {
        settings: {
            accessToken: "token",
            tasks: [placementTask],
            pendingSyncOperations: [{
                localTaskId: "place-local",
                didaId: "place-remote",
                projectId: "p2",
                type: "placement",
                payload: {
                    fromProjectId: "p1",
                    fromProjectName: "P1",
                    fromParentId: null,
                    toProjectId: "p2",
                    toProjectName: "P2",
                    toParentId: "parent-remote",
                    parentDidaId: "parent-remote"
                },
                createdAt: "2026-06-24T00:00:00+0800",
                attempts: 0
            }],
            reverseCompletionMeta: {},
            syncConsistencyMeta: {}
        },
        apiClient: {
            async moveTask() {
                placementMoveCount++;
            },
            async makeAuthenticatedRequest(url: string) {
                if (url.includes("/task/place-remote")) {
                    return { ok: false, status: 503, async text() { return "placement failed"; } };
                }
                return { ok: true, status: 200, async json() { return []; } };
            }
        },
        getProjectDisplayInfo(projectId: string, fallbackName?: string) {
            return { id: projectId, name: fallbackName || projectId };
        },
        refreshTaskView() { },
        async saveSettings() { },
        isReverseUpdating: false
    };
    const placementManager = new SyncManager(placementPlugin as any);
    const placementResult = await placementManager.flushPendingOperations();
    assert.equal(placementResult.uploaded, 0);
    assert.equal(placementResult.failed.length, 1);
    assert.match(placementResult.failed[0], /更新任务失败/);
    assert.equal(placementMoveCount, 2, "failed reparent after cross-project move should trigger remote compensation");
    assert.equal(placementTask.projectId, "p1", "successful compensation should restore local project");
    assert.equal(placementTask.parentId, null, "successful compensation should restore local parent");
    assert.equal(placementTask.syncPlacementPending, false);
    assert.ok(placementTask.syncPlacementError, "rollback should still leave a visible placement error");
    assert.equal(placementPlugin.settings.pendingSyncOperations.length, 0, "compensated placement failures should leave no retry item");

    statuses.length = 0;
    syncManager.isSyncing = true;
    await syncManager.syncFromDidaList();
    assert.deepEqual(statuses, [], "a skipped overlapping sync should not overwrite the active status");

    console.log("repeat task cloud authority regression test passed");
}

run()
    .finally(() => {
        (Module as any)._load = originalLoad;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
