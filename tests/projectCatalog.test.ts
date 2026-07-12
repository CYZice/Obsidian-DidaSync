import assert from "node:assert/strict";
import Module from "node:module";

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "obsidian") {
        class Plugin {
            app: any;
            constructor() { this.app = {}; }
            async loadData() { return {}; }
            async saveData(_data: any) { }
            addSettingTab() { }
            registerView() { }
            addRibbonIcon() { }
            addCommand() { }
        }
        class Modal { }
        class ItemView { }
        class PluginSettingTab { }
        class Setting {
            setName() { return this; }
            setDesc() { return this; }
            addText() { return this; }
            addTextArea() { return this; }
            addToggle() { return this; }
            addButton() { return this; }
            addDropdown() { return this; }
            addSlider() { return this; }
        }
        class TFile { }
        class Menu {
            setUseNativeMenu() { return this; }
            addItem() { return this; }
            showAtMouseEvent() { }
        }
        return {
            Plugin,
            Modal,
            ItemView,
            PluginSettingTab,
            Setting,
            TFile,
            Menu,
            Notice: class Notice { constructor(_message?: string) { } },
            Platform: { isMobile: false },
            normalizePath: (value: string) => value,
            getIconIds: () => ["lucide-inbox", "lucide-list-checks"],
            setIcon: () => { }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

async function run() {
    const DidaSyncPlugin = require("../src/main").default;
    const plugin = new DidaSyncPlugin();
    let saveCount = 0;
    plugin.settings = {
        tasks: [
            { id: "t1", title: "Inbox", status: 0, projectId: "inbox", projectName: "收集箱" },
            { id: "t2", title: "Alpha", status: 0, projectId: "p1", projectName: "项目甲" }
        ],
        projectCatalog: [
            { id: "p1", name: "项目甲", isArchived: false, isLocalOnly: false },
            { id: "p1", name: "项目甲 duplicate", isArchived: false, isLocalOnly: false },
            { id: "note-p", name: "Notes", isArchived: false, isLocalOnly: false, kind: "NOTE", viewMode: "note" },
            { id: "", name: "本地", isArchived: false, isLocalOnly: true }
        ],
        hiddenProjectKeys: ["id:inbox", "name:项目甲", "id:p1"],
        projectIcons: { "id:p1": "folder", "name:本地": "star" },
        projectOrder: ["项目甲", "本地"],
        projectCollapsedStates: { "项目甲": true },
        accessToken: ""
    };
    plugin.saveSettings = async () => { saveCount++; };
    plugin.refreshTaskView = () => { };

    assert.deepEqual(
        plugin.normalizeProjectCatalog(plugin.settings.projectCatalog).map((entry: any) => entry.name),
        ["项目甲", "Notes", "本地"]
    );
    assert.ok(plugin.getNoteSyncProjectConfigs().find((entry: any) => entry.id === "note-p"), "NOTE projects should be selectable for note sync");
    assert.equal(plugin.getAvailableProjectConfigs().some((entry: any) => entry.id === "note-p"), false, "NOTE projects should stay out of task project choices");
    assert.equal(plugin.getProjectTaskCount({ id: "p1", name: "项目甲", isArchived: false, isLocalOnly: false }), 1);
    assert.equal(plugin.getProjectDeleteState({ id: "inbox", name: "收集箱", isArchived: false, isLocalOnly: false }).disabled, true);
    assert.equal(plugin.getProjectDeleteState({ id: "p1", name: "项目甲", isArchived: false, isLocalOnly: false }).disabled, true);
    assert.equal(plugin.getProjectDeleteState({ id: "empty", name: "空项目", isArchived: false, isLocalOnly: true }).disabled, false);
    plugin.settings.didaNoteSyncProjectIds = ["inbox124125"];
    assert.equal(plugin.normalizeProjectDisplayId("inbox124125"), "inbox");
    assert.equal(plugin.areSameDidaProject("inbox124125", "inbox"), true);
    assert.equal(plugin.isSelectedDidaNoteSyncProjectId("inbox"), true);
    assert.deepEqual(
        plugin.getProjectDisplayInfo("inbox124125"),
        { id: "inbox", name: "收集箱", color: undefined, closed: undefined, viewMode: undefined, kind: undefined, permission: undefined, isLocalOnly: false }
    );

    plugin.sanitizeHiddenProjectKeys();
    assert.equal(plugin.settings.hiddenProjectKeys.includes("id:inbox"), false);
    assert.equal(plugin.settings.hiddenProjectKeys.includes("id:p1"), true);

    const changed = plugin.mergeRemoteProjectsIntoCatalog(new Map([
        ["p2", { id: "p2", name: "项目乙", closed: false }],
        ["p3", { id: "p3", name: "归档", closed: true }],
        ["note-remote", { id: "note-remote", name: "Remote Notes", closed: false, kind: "NOTE", viewMode: "note" }]
    ]));
    assert.equal(changed, true);
    assert.ok(plugin.settings.projectCatalog.find((entry: any) => entry.id === "p2"));
    assert.ok(plugin.settings.projectCatalog.find((entry: any) => entry.id === "note-remote"));
    assert.equal(plugin.getAvailableProjectConfigs().some((entry: any) => entry.id === "note-remote"), false);
    assert.ok(plugin.getNoteSyncProjectConfigs().find((entry: any) => entry.id === "note-remote"));
    assert.ok(plugin.settings.projectCatalog.find((entry: any) => entry.name === "本地")?.isLocalOnly);

    await plugin.applyLocalProjectRename({ id: "p1", name: "项目甲", isArchived: false, isLocalOnly: false }, "项目甲改名");
    assert.equal(plugin.settings.tasks[1].projectName, "项目甲改名");
    assert.equal(plugin.settings.projectCollapsedStates["项目甲改名"], true);

    await plugin.applyLocalProjectDelete({ id: "p1", name: "项目甲改名", isArchived: false, isLocalOnly: false });
    assert.equal(plugin.settings.projectCatalog.some((entry: any) => entry.id === "p1"), false);
    assert.equal(plugin.settings.projectIcons["id:p1"], undefined);
    assert.ok(saveCount >= 2);

    const originalWindow = (globalThis as any).window;
    const timers = new Map<number, () => void>();
    let nextTimerId = 1;
    (globalThis as any).window = {
        setTimeout(callback: () => void) {
            const id = nextTimerId++;
            timers.set(id, callback);
            return id;
        },
        clearTimeout(id: number) {
            timers.delete(id);
        }
    };
    try {
        plugin.settings.autoSync = true;
        plugin.settings.accessToken = "access-token";
        plugin.settings.syncInterval = 5;
        plugin.setupAutoSync();
        assert.equal(timers.size, 1, "auto sync should schedule one timer");
        const firstTimerId = plugin.autoSyncTimeout;

        plugin.setupAutoSync();
        assert.equal(timers.size, 1, "rescheduling should replace the existing timer");
        assert.notEqual(plugin.autoSyncTimeout, firstTimerId, "rescheduling should create a fresh timer");

        plugin.clearAutoSync();
        let finishSync: (() => void) | undefined;
        plugin.syncManager = {
            runBidirectionalSync: () => new Promise<void>((resolve) => {
                finishSync = resolve;
            })
        };
        const tick = plugin.handleAutoSyncTick();
        assert.equal(timers.size, 0, "the next timer should not be scheduled while syncing");
        finishSync?.();
        await tick;
        assert.equal(timers.size, 1, "the next timer should be scheduled after syncing finishes");

        plugin.settings.autoSync = false;
        plugin.setupAutoSync();
        assert.equal(timers.size, 0, "disabling auto sync should clear the scheduled timer");

        let viewOpenSyncCount = 0;
        plugin.syncManager = {
            async runBidirectionalSync() {
                viewOpenSyncCount++;
            }
        };
        plugin._lastRecoverySyncAt = 0;
        await plugin.requestRecoverySync({ requireAutoSync: false });
        assert.equal(viewOpenSyncCount, 1, "opening the task view should refresh even when auto sync is disabled");
        plugin._lastRecoverySyncAt = 0;
        await plugin.requestRecoverySync();
        assert.equal(viewOpenSyncCount, 1, "background recovery should still respect the auto sync setting");

        const statuses: string[] = [];
        const originalSetTimeout = globalThis.setTimeout;
        (globalThis as any).setTimeout = (callback: () => void) => {
            callback();
            return 1;
        };
        try {
            plugin.updateStatusBar = (status: string) => {
                statuses.push(status);
            };
            plugin.syncManager = {
                async runBidirectionalSync() {
                    plugin.updateStatusBar("双向同步中...");
                    assert.deepEqual(statuses, ["双向同步中..."], "safe manual sync should show progress before uploading");
                }
            };
            await plugin.safeManualSync();
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }
    } finally {
        (globalThis as any).window = originalWindow;
    }

    console.log("Project catalog tests passed");
}

run()
    .finally(() => {
        (Module as any)._load = originalLoad;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
