import assert from "node:assert/strict";
import Module from "node:module";

const notices: string[] = [];
const originalLoad = (Module as any)._load;

class MockTFile {
    path: string;
    basename: string;
    extension: string;
    constructor(path = "DidaNotes/Test.md") {
        this.path = path;
        this.basename = path.replace(/\.md$/, "").split("/").pop() || path;
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
    if (request === "obsidian") return obsidianMock;
    if (request === "../main" || request.endsWith("/main")) return class DidaSyncPlugin { };
    return originalLoad.call(this, request, parent, isMain);
};

function makeApp() {
    const vaultData = new Map<string, string>();
    const abstractFiles = new Map<string, any>();
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
            modify: async (file: any, content: string) => vaultData.set(file.path, content)
        },
        metadataCache: {
            getFileCache: () => null
        },
        workspace: { getLeaf: () => ({ openFile: async () => { } }) }
    };
    return { app, vaultData, abstractFiles };
}

function makePlugin(app: any) {
    let remoteBody = "remote body";
    let remoteEtag = "e1";
    let remoteItems: any[] | null = null;
    const updates: any[] = [];
    const filters: any[] = [];
    const plugin = {
        app,
        settings: {
            enableDidaNoteSync: true,
            accessToken: "token",
            didaNoteSyncFolder: "DidaNotes",
            didaNoteSyncProjectIds: ["p1"],
            didaNoteSyncRecords: [],
            didaNoteSyncLastRun: null,
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
                    title: "Test Note",
                    content: remoteBody,
                    desc: "",
                    kind: "NOTE",
                    projectId: "p1",
                    projectName: "Notes Project",
                    status: 0,
                    etag: remoteEtag,
                    modifiedTime: remoteEtag
                }];
            },
            updateNote: async (_id: string, payload: any) => {
                updates.push(payload);
                remoteBody = payload.content;
                remoteEtag = "e2";
                return { etag: remoteEtag, modifiedTime: "e2" };
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
        setRemote(body: string, etag: string) { remoteBody = body; remoteEtag = etag; remoteItems = null; },
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

    const secondSummary = await manager.syncNow({ silent: true });
    assert.equal(secondSummary.conflicts, 0, "freshly pulled note should not be detected as a local/cloud conflict");
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "synced");
    assert.equal(updates.length, 0, "freshly pulled note should not be pushed back without local edits");

    const file = app.vault.getAbstractFileByPath(record.path);
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
    assert.match(conflicted, /滴答笔记同步冲突/);
    assert.equal(plugin.settings.didaNoteSyncRecords[0].status, "conflict");
    assert.equal(plugin.settings.didaNoteSyncLastRun.conflicts, 1);

    await app.vault.modify(file, conflicted.replace(/^> \[!warning\].*\n> .*\n\n/m, "").replace("local body again", "merged body"));
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

    const beforeMissingFilePushUpdates = updates.length;
    abstractFiles.delete(record.path);
    await assert.rejects(() => manager.forcePushRecord("note-1"), /Markdown/);
    assert.equal(updates.length, beforeMissingFilePushUpdates);

    abstractFiles.set(record.path, file);
    vaultData.set(record.path, buildLegacyFrontmatter(plugin.settings.didaNoteSyncRecords[0], "legacy local body"));
    const deleted = await manager.deleteLocalRecord("note-1");
    assert.equal(deleted, true);
    assert.equal(plugin.settings.didaNoteSyncRecords.length, 0);

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
    assert.equal(fallbackRuntime.plugin.settings.tasks.length, 2);
    assert.deepEqual(
        fallbackRuntime.plugin.settings.tasks.map((item: any) => [item.kind, item.projectId, item.projectKind, item.projectViewMode]),
        [["NOTE", "p1", "NOTE", "note"], ["NOTE", "p1", "NOTE", "note"]]
    );

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
    assert.equal(inboxRuntime.plugin.settings.tasks[0].projectId, "inbox");
    assert.equal(inboxRuntime.plugin.settings.tasks[0].projectName, "收集箱");

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
