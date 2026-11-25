import assert from "node:assert/strict";
import Module from "node:module";
import { MessageKey, MessageParams, translate } from "../src/i18n";

const notices: string[] = [];
const originalLoad = (Module as any)._load;

class MockTFile {
    path: string;
    basename: string;
    extension: string;
    stat: { mtime: number };
    constructor(path = "DidaNotes/Test.md") {
        this.path = path;
        this.basename = path.replace(/\.md$/, "").split("/").pop() || path;
        this.extension = "md";
        this.stat = { mtime: Date.now() };
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
    if (request === "obsidian") return obsidianMock;
    if (request === "../main" || request.endsWith("/main")) return class DidaSyncPlugin { };
    return originalLoad.call(this, request, parent, isMain);
};

function makeApp() {
    const vaultData = new Map<string, string>();
    const abstractFiles = new Map<string, any>();
    const eventHandlers = new Map<string, Array<(...args: any[]) => any>>();
    const emit = async (name: string, ...args: any[]) => {
        for (const handler of eventHandlers.get(name) || []) {
            await handler(...args);
        }
    };
    const moveFile = async (file: any, newPath: string, emitEvent: boolean) => {
        const oldPath = file.path;
        const content = vaultData.get(oldPath) ?? "";
        abstractFiles.delete(oldPath);
        vaultData.delete(oldPath);
        file.path = newPath;
        file.basename = newPath.replace(/\.md$/, "").split("/").pop() || newPath;
        abstractFiles.set(newPath, file);
        vaultData.set(newPath, content);
        if (emitEvent) await emit("rename", file, oldPath);
    };
    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => abstractFiles.get(path) || null,
            getMarkdownFiles: () => Array.from(abstractFiles.values()).filter((file) => file instanceof MockTFile),
            createFolder: async (path: string) => abstractFiles.set(path, { path, children: [] }),
            create: async (path: string, content: string) => {
                const file = new MockTFile(path);
                abstractFiles.set(path, file);
                vaultData.set(path, content);
                return file;
            },
            read: async (file: any) => vaultData.get(file.path) || "",
            cachedRead: async (file: any) => vaultData.get(file.path) || "",
            modify: async (file: any, content: string) => {
                file.stat.mtime = Math.max(Date.now(), file.stat.mtime + 1000);
                vaultData.set(file.path, content);
            },
            on: (name: string, callback: (...args: any[]) => any) => {
                const handlers = eventHandlers.get(name) || [];
                handlers.push(callback);
                eventHandlers.set(name, handlers);
                return { name };
            }
        },
        fileManager: {
            renameFile: async (file: any, newPath: string) => {
                await moveFile(file, newPath, true);
            }
        },
        metadataCache: {
            getFileCache: () => null
        },
        workspace: { getLeaf: () => ({ openFile: async () => { } }) }
    };
    return { app, vaultData, abstractFiles, emit, moveFile };
}

function makePlugin(app: any) {
    let remoteBody = "remote body";
    let remoteTitle = "Test Note";
    let remoteEtag = "e1";
    let remoteModifiedTime = new Date(Date.now() - 60_000).toISOString();
    let remoteItems: any[] | null = null;
    const updates: any[] = [];
    const filters: any[] = [];
    const plugin = {
        app,
        t(key: MessageKey, params?: MessageParams) { return translate("zh", key, params); },
        settings: {
            enableDidaNoteSync: true,
            accessToken: "token",
            didaNoteSyncFolder: "DidaNotes",
            didaNoteSyncProjectIds: ["p1"],
            didaNoteSyncRecords: [],
            didaNoteSyncLastRun: null,
            didaNoteSyncTitleToFilename: false,
            detachedSyncEntities: [],
            syncDeletionCandidates: [],
            nativeTaskLinkIndex: {},
            tasks: [],
            projectCatalog: [
                { id: "p1", name: "Notes Project", isArchived: false, isLocalOnly: false, kind: "NOTE", viewMode: "note" }
            ]
        },
        apiClient: {
            filterTasks: async (filter: any) => {
                filters.push(filter);
                return remoteItems ?? [{
                    id: "note-1",
                    title: remoteTitle,
                    content: remoteBody,
                    desc: "",
                    kind: "NOTE",
                    projectId: "p1",
                    projectName: "Notes Project",
                    status: 0,
                    etag: remoteEtag,
                    modifiedTime: remoteModifiedTime
                }];
            },
            updateNote: async (_id: string, payload: any) => {
                updates.push(payload);
                remoteBody = payload.content;
                remoteTitle = payload.title;
                remoteEtag = "e2";
                remoteModifiedTime = new Date(Date.now()).toISOString();
                return { etag: remoteEtag, modifiedTime: remoteModifiedTime };
            }
        },
        normalizeRemoteTask(task: any) {
            return {
                ...task,
                didaId: task.id,
                updatedAt: task.modifiedTime,
                items: []
            };
        },
        resolveTaskProjectInfo(task: any) {
            return { id: task.projectId, name: task.projectName || task.projectId };
        },
        normalizeProjectDisplayId(projectId: any) {
            const id = typeof projectId === "string" && projectId.trim() ? projectId.trim() : "inbox";
            return id.toLowerCase().startsWith("inbox") ? "inbox" : id;
        },
        getProjectDisplayInfo(projectId: string, fallbackName?: string) {
            const id = this.normalizeProjectDisplayId(projectId);
            const project = this.settings.projectCatalog.find((entry: any) => entry.id === id);
            return {
                id,
                name: id === "inbox" ? "收集箱" : project?.name || fallbackName || id,
                kind: project?.kind,
                viewMode: project?.viewMode
            };
        },
        getProjectCatalog() {
            return this.settings.projectCatalog;
        },
        getUserTimeZone() { return "Asia/Shanghai"; },
        async saveSettings() { },
        refreshTaskView() { }
    };
    return {
        plugin,
        updates,
        filters,
        setRemote(body: string, etag: string) {
            remoteBody = body;
            remoteEtag = etag;
            remoteModifiedTime = new Date(Date.now() + 120_000).toISOString();
            remoteItems = null;
        },
        setRemoteTitle(title: string, etag: string) {
            remoteTitle = title;
            remoteEtag = etag;
            remoteModifiedTime = new Date(Date.now() + 120_000).toISOString();
            remoteItems = null;
        },
        setRemoteItems(items: any[]) { remoteItems = items; }
    };
}

function buildLegacyFrontmatter(record: any, body: string) {
    return [
        "---",
        `didaNoteId: "${record.didaId}"`,
        `didaNoteKind: "NOTE"`,
        `didaNoteSyncStatus: "${record.status}"`,
        `didaEtag: "${record.etag || ""}"`,
        `didaModifiedTime: "${record.remoteModifiedTime || ""}"`,
        `didaLastSyncedContentHash: "${record.lastSyncedContentHash}"`,
        `didaLastSyncedAt: "${record.lastSyncedAt}"`,
        "---",
        "",
        body,
        ""
    ].join("\n");
}

async function run() {
    const { NoteSyncManager } = require("../src/managers/NoteSyncManager");
    const { app, vaultData, abstractFiles } = makeApp();
    const { plugin, updates, filters, setRemote, setRemoteItems } = makePlugin(app);
    const manager = new NoteSyncManager(app as any, plugin as any);

    plugin.settings.didaNoteSyncProjectIds = [];
    notices.length = 0;
    await manager.syncNow({ silent: true });
    assert.equal(notices.length, 0, "silent note sync should not show notice when projects are not selected");
    assert.equal(filters.length, 0, "silent note sync without selected projects should not query notes");

    await manager.syncNow();
    assert.equal(filters.length, 0, "without selected projects note sync should not query all notes");
    assert.equal(plugin.settings.didaNoteSyncRecords.length, 0);
    assert.equal(plugin.settings.didaNoteSyncLastRun.summaryText, "请先选择笔记清单");

    plugin.settings.didaNoteSyncProjectIds = ["p1"];

    notices.length = 0;
    const firstSummary = await manager.syncNow({ silent: true, source: "auto" });
    assert.equal(notices.length, 0, "silent note sync should not show completion notice");
    assert.equal(firstSummary.outcome, "success");
    assert.equal(plugin.settings.didaNoteSyncLastRun.source, "auto");
    assert.equal(plugin.settings.didaNoteSyncRecords.length, 1);

    assert.deepEqual(filters.at(-1), { kind: ["NOTE"], status: [0], projectIds: ["p1"] });
    const record = plugin.settings.didaNoteSyncRecords[0];
    assert.equal(record.projectId, "p1");
    assert.equal(record.projectName, "Notes Project");
    assert.match(record.path, /^DidaNotes\/Test Note-/);
    assert.match(vaultData.get(record.path) || "", /didaNoteId: 'note-1'/);
    assert.match(vaultData.get(record.path) || "", /\n---\n## Test Note\n\nremote body\n?$/);
    assert.match(vaultData.get(record.path) || "", /remote body/);
    assert.equal(plugin.settings.tasks.some((task: any) => task.kind === "NOTE"), false, "note sync should not cache pulled notes in task list storage");

    plugin.settings.tasks = [
        { id: "legacy-note-cache", didaId: "note-1", title: "Legacy Note Cache", kind: "NOTE", status: 0, projectId: "p1" },
        { id: "task-kept", didaId: "task-remote", title: "Task Kept", kind: "TEXT", status: 0, projectId: "p1" }
    ];

    const secondSummary = await manager.syncNow({ silent: true });
    assert.equal(secondSummary.conflicts, 0, "freshly pulled note should not be detected as a local/cloud conflict");
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "synced");
    assert.equal(updates.length, 0, "freshly pulled note should not be pushed back without local edits");
    assert.deepEqual(plugin.settings.tasks.map((task: any) => task.id), ["task-kept"], "legacy note cache should be removed without touching normal tasks");

    const file = app.vault.getAbstractFileByPath(record.path);
    abstractFiles.delete(record.path);
    await manager.syncNow({ silent: true });
    assert.equal(abstractFiles.has(record.path), false, "automatic sync must not recreate a locally deleted note before confirmation");
    assert.equal(plugin.settings.syncDeletionCandidates[0].id, "note:note-1");
    abstractFiles.set(record.path, file);
    await manager.syncNow({ silent: true });
    assert.equal(plugin.settings.syncDeletionCandidates.length, 0, "restoring the local note should clear the deletion candidate");

    const localChanged = (vaultData.get(record.path) || "").replace("remote body", "local body");
    await app.vault.modify(file, localChanged);
    await manager.syncNow();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].title, "Test Note");
    assert.equal(updates[0].content, "local body");
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "synced");

    const conflictBase = vaultData.get(record.path) || "";
    await app.vault.modify(file, conflictBase.replace("local body", "local body again"));
    setRemote("remote body again", "e3");
    await manager.syncNow();
    const conflicted = vaultData.get(record.path) || "";
    assert.doesNotMatch(conflicted, /滴答笔记同步冲突/);
    assert.match(conflicted, /remote body again/);
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "synced");
    assert.equal(plugin.settings.didaNoteSyncLastRun.conflicts, 0);

    await app.vault.modify(file, conflicted.replace("remote body again", "merged body"));
    await manager.syncNow();
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "synced");
    assert.equal(updates.at(-1).content, "merged body");

    setRemote("forced remote body", "e4");
    await app.vault.modify(file, (vaultData.get(record.path) || "").replace("merged body", "local before force pull"));
    const pulled = await manager.forcePullRecord("note-1");
    assert.equal(pulled, true);
    assert.match(vaultData.get(record.path) || "", /forced remote body/);
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "synced");
    assert.equal(plugin.settings.didaNoteSyncLastRun.synced, 1);
    assert.equal(plugin.settings.didaNoteSyncLastRun.pushed, 0);
    assert.equal(plugin.settings.didaNoteSyncLastRun.conflicts, 0);
    assert.match(vaultData.get(record.path) || "", /\n---\n## Test Note\n\nforced remote body\n?$/);

    const beforeForcePushUpdates = updates.length;
    await app.vault.modify(file, (vaultData.get(record.path) || "")
        .replace("## Test Note", "## Renamed Note")
        .replace("forced remote body", "forced local body"));
    const pushed = await manager.forcePushRecord("note-1");
    assert.equal(pushed, true);
    assert.equal(updates.length, beforeForcePushUpdates + 1);
    assert.equal(updates.at(-1).title, "Renamed Note");
    assert.equal(updates.at(-1).content, "forced local body");
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "synced");
    assert.equal(plugin.settings.didaNoteSyncLastRun.synced, 0);
    assert.equal(plugin.settings.didaNoteSyncLastRun.pushed, 1);
    assert.equal(plugin.settings.didaNoteSyncLastRun.conflicts, 0);
    assert.match(vaultData.get(record.path) || "", /\n---\n## Renamed Note\n\nforced local body\n?$/);

    setRemoteItems([]);
    const missingPulled = await manager.forcePullRecord("note-1");
    assert.equal(missingPulled, false);
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "missing");
    assert.equal(plugin.settings.didaNoteSyncRecords[0].remoteMissing, true);
    assert.equal(plugin.settings.tasks.some((task: any) => task.didaId === "note-1"), false);
    plugin.settings.tasks.push({ id: "legacy-note-cache-2", didaId: "note-1", title: "Legacy Note Cache 2", kind: "NOTE", status: 0, projectId: "p1" });
    assert.equal(plugin.settings.tasks.some((task: any) => task.didaId === "note-1"), true);

    const beforeMissingFilePushUpdates = updates.length;
    abstractFiles.delete(record.path);
    await assert.rejects(() => manager.forcePushRecord("note-1"), /Markdown/);
    assert.equal(updates.length, beforeMissingFilePushUpdates);

    abstractFiles.set(record.path, file);
    vaultData.set(record.path, buildLegacyFrontmatter(plugin.settings.didaNoteSyncRecords[0], "legacy local body"));
    const deleted = await manager.deleteLocalRecord("note-1");
    assert.equal(deleted, true);
    assert.equal(plugin.settings.didaNoteSyncRecords.length, 0);
    assert.equal(plugin.settings.tasks.some((task: any) => task.didaId === "note-1"), false);
    assert.equal(plugin.settings.tasks.some((task: any) => task.id === "task-kept"), true);

    setRemote("legacy local body", "e5");
    await manager.syncNow({ silent: true });
    assert.equal(plugin.settings.didaNoteSyncRecords.length, 1);
    assert.equal(plugin.settings.didaNoteSyncRecords[0].path, record.path, "existing legacy frontmatter file should be re-linked");
    assert.equal(app.vault.getMarkdownFiles().length, 1, "re-link should not create duplicate markdown files");

    const duplicatePath = "DidaNotes/Test Note-duplicate.md";
    abstractFiles.set(duplicatePath, new MockTFile(duplicatePath));
    vaultData.set(duplicatePath, buildLegacyFrontmatter(plugin.settings.didaNoteSyncRecords[0], "duplicate local body"));
    await manager.deleteLocalRecord("note-1");
    await manager.syncNow({ silent: true });
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "error");
    assert.match(plugin.settings.didaNoteSyncRecords[0].error || "", /多个本地 Markdown/);
    assert.equal(plugin.settings.didaNoteSyncLastRun.errors.length, 1);
    assert.match(plugin.settings.didaNoteSyncLastRun.summaryText, /失败 1 条/);

    const fallbackEnv = makeApp();
    const fallbackRuntime = makePlugin(fallbackEnv.app);
    const fallbackManager = new NoteSyncManager(fallbackEnv.app as any, fallbackRuntime.plugin as any);
    fallbackRuntime.setRemoteItems([
        {
            id: "note-a",
            title: "Note A",
            content: "A body",
            kind: "NOTE",
            status: 0,
            etag: "a1",
            modifiedTime: "a1"
        },
        {
            id: "note-b",
            title: "Note B",
            content: "B body",
            kind: "NOTE",
            status: 0,
            etag: "b1",
            modifiedTime: "b1"
        }
    ]);
    await fallbackManager.syncNow({ silent: true });
    assert.equal(fallbackRuntime.plugin.settings.didaNoteSyncRecords.length, 2, "all pulled notes should stay visible as records");
    assert.deepEqual(
        fallbackRuntime.plugin.settings.didaNoteSyncRecords.map((item: any) => item.projectId),
        ["p1", "p1"],
        "single selected note project should be used when the NOTE payload omits projectId"
    );
    assert.equal(fallbackRuntime.plugin.settings.tasks.length, 0, "note records should not create task-list cache entries");

    const inboxEnv = makeApp();
    const inboxRuntime = makePlugin(inboxEnv.app);
    inboxRuntime.plugin.settings.didaNoteSyncProjectIds = ["inbox124125"];
    inboxRuntime.plugin.settings.remoteInboxProjectId = "inbox124125";
    inboxRuntime.setRemoteItems([
        {
            id: "inbox-note",
            title: "Inbox Note",
            content: "Inbox body",
            kind: "NOTE",
            status: 0,
            etag: "i1",
            modifiedTime: "i1"
        }
    ]);
    const inboxManager = new NoteSyncManager(inboxEnv.app as any, inboxRuntime.plugin as any);
    await inboxManager.syncNow({ silent: true });
    assert.deepEqual(inboxRuntime.filters.at(-1), { kind: ["NOTE"], status: [0], projectIds: ["inbox124125"] });
    assert.equal(inboxRuntime.plugin.settings.didaNoteSyncRecords[0].projectId, "inbox");
    assert.equal(inboxRuntime.plugin.settings.didaNoteSyncRecords[0].projectName, "收集箱");
    assert.equal(inboxRuntime.plugin.settings.tasks.length, 0);

    const trackerEnv = makeApp();
    const trackerRuntime = makePlugin(trackerEnv.app);
    const { LocalDeletionTracker } = require("../src/sync/LocalDeletionTracker");
    const tracker = new LocalDeletionTracker(trackerEnv.app as any, trackerRuntime.plugin as any);
    trackerRuntime.plugin.settings.tasks = [{ id: "local-task", didaId: "remote-task", title: "Linked Task", projectId: "p1", status: 0 }];
    const linkedFile = await trackerEnv.app.vault.create("Tasks.md", "- [ ] Linked Task [🔗Dida](obsidian://dida-task?didaId=remote-task)\n");
    await tracker.scan();
    assert.equal(trackerRuntime.plugin.settings.nativeTaskLinkIndex["remote-task"].path, "Tasks.md");
    await trackerEnv.app.vault.modify(linkedFile, "- [ ] another task\n");
    await tracker.scan();
    assert.equal(tracker.list()[0].reason, "local_task_line_missing");
    await tracker.detach(tracker.list()[0]);
    assert.equal(tracker.list().length, 0);
    assert.equal(trackerRuntime.plugin.settings.detachedSyncEntities.includes("task:remote-task"), true);

    // ------------------------------------------------- title <-> file name sync
    const enabledEnv = makeApp();
    const enabledRuntime = makePlugin(enabledEnv.app);
    enabledRuntime.plugin.settings.didaNoteSyncTitleToFilename = true;
    const enabledManager = new NoteSyncManager(enabledEnv.app as any, enabledRuntime.plugin as any);
    const renameOutcomes: boolean[] = [];
    enabledEnv.app.vault.on("rename", async (renamed: any, previousPath: string) => {
        renameOutcomes.push(await enabledManager.handleFileRename(renamed, previousPath));
    });

    const enabledFirstSummary = await enabledManager.syncNow({ silent: true });
    assert.equal(enabledFirstSummary.synced, 1);
    let enabledRecord = enabledRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.equal(enabledRecord.path, "DidaNotes/Test Note.md");
    assert.equal(enabledRecord.localFileStem, "Test Note");
    assert.equal(enabledRecord.contentFormat, "plain");
    assert.match(enabledEnv.vaultData.get(enabledRecord.path) || "", /didaNoteId: 'note-1'/);
    assert.doesNotMatch(enabledEnv.vaultData.get(enabledRecord.path) || "", /## Test Note/);
    assert.match(enabledEnv.vaultData.get(enabledRecord.path) || "", /\n---\nremote body\n?$/);
    assert.equal(enabledRuntime.updates.length, 0);

    enabledRuntime.setRemoteTitle("Renamed Note", "e2");
    const remoteRenameSummary = await enabledManager.syncNow({ silent: true });
    enabledRecord = enabledRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.equal(enabledEnv.abstractFiles.has("DidaNotes/Test Note.md"), false);
    assert.equal(enabledEnv.abstractFiles.has("DidaNotes/Renamed Note.md"), true);
    assert.equal(enabledRecord.path, "DidaNotes/Renamed Note.md");
    assert.equal(enabledRecord.localFileStem, "Renamed Note");
    assert.equal(remoteRenameSummary.renamed, 1);
    assert.equal(enabledRuntime.updates.length, 0, "a remote rename must not be pushed back");
    assert.deepEqual(renameOutcomes, [false], "the plugin's own rename event must be ignored");

    const stableEnabledSummary = await enabledManager.syncNow({ silent: true });
    assert.equal(stableEnabledSummary.renamed, 0);
    assert.equal(enabledRuntime.updates.length, 0);

    // Obsidian-side rename is pushed as the remote title, exactly once.
    const enabledFile = enabledEnv.app.vault.getAbstractFileByPath(enabledRecord.path);
    const oldEnabledPath = enabledRecord.path;
    await enabledEnv.moveFile(enabledFile, "DidaNotes/User Title.md", false);
    assert.equal(await enabledManager.handleFileRename(enabledFile, oldEnabledPath), true);
    await enabledManager.syncNow({ silent: true });
    assert.equal(enabledRuntime.updates.length, 1);
    assert.equal(enabledRuntime.updates.at(-1).title, "User Title");
    assert.equal(enabledRuntime.updates.at(-1).content, "remote body");
    enabledRecord = enabledRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.equal(enabledRecord.title, "User Title");
    assert.equal(enabledRecord.path, "DidaNotes/User Title.md");
    assert.equal(enabledRecord.localFileStem, "User Title");
    const afterPushSummary = await enabledManager.syncNow({ silent: true });
    assert.equal(enabledRuntime.updates.length, 1, "renaming must not loop");
    assert.equal(afterPushSummary.renamed, 0);

    // Rename with a lost event (e.g. app closed) heals through didaNoteId.
    const healedFile = enabledEnv.app.vault.getAbstractFileByPath(enabledRecord.path);
    await enabledEnv.moveFile(healedFile, "DidaNotes/Healed Title.md", false);
    await enabledManager.syncNow({ silent: true });
    enabledRecord = enabledRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.equal(enabledRecord.path, "DidaNotes/Healed Title.md");
    assert.equal(enabledRecord.title, "Healed Title");
    assert.equal(enabledRuntime.updates.length, 2);
    assert.equal((enabledRuntime.plugin.settings.syncDeletionCandidates || []).length, 0);
    assert.equal(enabledEnv.app.vault.getMarkdownFiles().length, 1, "a rename must not create a copy");
    await enabledManager.syncNow({ silent: true });
    assert.equal(enabledRuntime.updates.length, 2);

    // Same-title notes get stable ` (1)` / ` (2)` conflict names.
    const conflictEnv = makeApp();
    const conflictRuntime = makePlugin(conflictEnv.app);
    conflictRuntime.plugin.settings.didaNoteSyncTitleToFilename = true;
    conflictRuntime.setRemoteItems([
        { id: "same-a", title: "Same", content: "A body", kind: "NOTE", status: 0, etag: "a1", modifiedTime: "a1" },
        { id: "same-b", title: "Same", content: "B body", kind: "NOTE", status: 0, etag: "b1", modifiedTime: "b1" }
    ]);
    const conflictManager = new NoteSyncManager(conflictEnv.app as any, conflictRuntime.plugin as any);
    await conflictManager.syncNow({ silent: true });
    assert.equal(conflictEnv.abstractFiles.has("DidaNotes/Same.md"), true);
    assert.equal(conflictEnv.abstractFiles.has("DidaNotes/Same (1).md"), true);
    await conflictManager.syncNow({ silent: true });
    assert.equal(conflictEnv.abstractFiles.has("DidaNotes/Same.md"), true);
    assert.equal(conflictEnv.abstractFiles.has("DidaNotes/Same (1).md"), true);
    assert.equal(conflictRuntime.updates.length, 0);

    // Blank remote titles fall back to 未命名 without repeated writes.
    const untitledEnv = makeApp();
    const untitledRuntime = makePlugin(untitledEnv.app);
    untitledRuntime.plugin.settings.didaNoteSyncTitleToFilename = true;
    untitledRuntime.setRemoteItems([
        { id: "empty-1", title: "", content: "hello", kind: "NOTE", status: 0, etag: "u1", modifiedTime: "u1" }
    ]);
    const untitledManager = new NoteSyncManager(untitledEnv.app as any, untitledRuntime.plugin as any);
    await untitledManager.syncNow({ silent: true });
    assert.equal(untitledEnv.abstractFiles.has("DidaNotes/未命名.md"), true);
    await untitledManager.syncNow({ silent: true });
    assert.equal(untitledRuntime.updates.length, 0);

    // Enabling the setting migrates existing legacy notes without pushing.
    const migrateEnv = makeApp();
    const migrateRuntime = makePlugin(migrateEnv.app);
    const migrateManager = new NoteSyncManager(migrateEnv.app as any, migrateRuntime.plugin as any);
    await migrateManager.syncNow({ silent: true });
    let migrateRecord = migrateRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.match(migrateRecord.path, /^DidaNotes\/Test Note-/);
    assert.match(migrateEnv.vaultData.get(migrateRecord.path) || "", /## Test Note/);

    migrateRuntime.plugin.settings.didaNoteSyncTitleToFilename = true;
    const migrateSummary = await migrateManager.syncNow({ silent: true });
    migrateRecord = migrateRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.equal(migrateRecord.path, "DidaNotes/Test Note.md");
    assert.equal(migrateRecord.contentFormat, "plain");
    assert.equal(migrateRecord.localFileStem, "Test Note");
    assert.equal(migrateRuntime.updates.length, 0, "cleaning a legacy note must not push content");
    assert.equal(migrateSummary.renamed, 1);
    assert.doesNotMatch(migrateEnv.vaultData.get(migrateRecord.path) || "", /## Test Note/);
    assert.match(migrateEnv.vaultData.get(migrateRecord.path) || "", /remote body/);

    // Legacy notes edited locally keep their edits when migrated.
    const migrateEditEnv = makeApp();
    const migrateEditRuntime = makePlugin(migrateEditEnv.app);
    const migrateEditManager = new NoteSyncManager(migrateEditEnv.app as any, migrateEditRuntime.plugin as any);
    await migrateEditManager.syncNow({ silent: true });
    const migrateEditRecord = migrateEditRuntime.plugin.settings.didaNoteSyncRecords[0];
    const migrateEditFile = migrateEditEnv.app.vault.getAbstractFileByPath(migrateEditRecord.path);
    await migrateEditEnv.app.vault.modify(
        migrateEditFile,
        (migrateEditEnv.vaultData.get(migrateEditRecord.path) || "").replace("remote body", "edited body")
    );
    migrateEditRuntime.plugin.settings.didaNoteSyncTitleToFilename = true;
    await migrateEditManager.syncNow({ silent: true });
    assert.equal(migrateEditRuntime.updates.length, 1);
    assert.equal(migrateEditRuntime.updates.at(-1).title, "Test Note");
    assert.equal(migrateEditRuntime.updates.at(-1).content, "edited body");
    const migratedEdited = migrateEditRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.equal(migratedEdited.path, "DidaNotes/Test Note.md");
    assert.doesNotMatch(migrateEditEnv.vaultData.get(migratedEdited.path) || "", /## Test Note/);

    // With the setting off, a rename still heals instead of looking deleted.
    const disabledEnv = makeApp();
    const disabledRuntime = makePlugin(disabledEnv.app);
    const disabledManager = new NoteSyncManager(disabledEnv.app as any, disabledRuntime.plugin as any);
    await disabledManager.syncNow({ silent: true });
    let disabledRecord = disabledRuntime.plugin.settings.didaNoteSyncRecords[0];
    const disabledFile = disabledEnv.app.vault.getAbstractFileByPath(disabledRecord.path);
    const oldDisabledPath = disabledRecord.path;
    await disabledEnv.moveFile(disabledFile, "DidaNotes/Manual Rename.md", false);
    assert.equal(await disabledManager.handleFileRename(disabledFile, oldDisabledPath), false);
    assert.equal(disabledRuntime.plugin.settings.didaNoteSyncRecords[0].path, "DidaNotes/Manual Rename.md");
    await disabledManager.syncNow({ silent: true });
    disabledRecord = disabledRuntime.plugin.settings.didaNoteSyncRecords[0];
    assert.equal(disabledRecord.path, "DidaNotes/Manual Rename.md");
    assert.equal(disabledRuntime.updates.length, 0);
    assert.equal((disabledRuntime.plugin.settings.syncDeletionCandidates || []).length, 0);
    assert.equal(disabledEnv.app.vault.getMarkdownFiles().length, 1);

    console.log("NoteSyncManager tests passed");
}

run()
    .finally(() => {
        (Module as any)._load = originalLoad;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
