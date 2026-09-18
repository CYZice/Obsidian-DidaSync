import assert from "node:assert/strict";
import Module from "node:module";

const originalLoad = (Module as any)._load;
const notices: string[] = [];

(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "obsidian") {
        return {
            App: class App { },
            ItemView: class ItemView { },
            MarkdownView: class MarkdownView { },
            Menu: class Menu { },
            Modal: class Modal { },
            Notice: class Notice {
                constructor(message: string) {
                    notices.push(message);
                }
            },
            Platform: { isMobile: false },
            Plugin: class Plugin { },
            PluginSettingTab: class PluginSettingTab { },
            Setting: class Setting { },
            TFile: class TFile { },
            WorkspaceLeaf: class WorkspaceLeaf { },
            getIconIds: () => [],
            getLanguage: () => "en",
            normalizePath: (path: string) => path,
            setIcon: () => { },
            requestUrl: async () => ({ status: 200, json: async () => ({}) })
        };
    }
    if (request === "electron") return {};
    return originalLoad.call(this, request, parent, isMain);
};

type PluginOptions = {
    parentDidaId?: string | null;
    hasParent?: boolean;
    parentProjectId?: string;
    parentProjectName?: string;
    childProjectName?: string;
    responseParentId?: string | null;
    enableIndentedSubtasks?: boolean;
};

function makePlugin(options: PluginOptions = {}) {
    const DidaSyncPlugin = require("../src/main").default;
    const { NativeTaskSyncManager } = require("../src/managers/NativeTaskSyncManager");
    const plugin = new DidaSyncPlugin();
    const requests: any[] = [];
    let updatedLine = "";
    const hasParent = options.hasParent !== false;
    const parentDidaId = options.parentDidaId || null;
    const parentProjectId = options.parentProjectId || "p1";
    const parentProjectName = options.parentProjectName || "Project One";
    const taskLine = hasParent
        ? `  - [ ] Child${options.childProjectName ? ` ^[${options.childProjectName}]` : ""}`
        : "- [ ] Root";
    const content = hasParent
        ? [
            parentDidaId
                ? `- [ ] Parent [🔗Dida](obsidian://dida-task?didaId=${parentDidaId})`
                : "- [ ] Parent",
            taskLine
        ].join("\n")
        : taskLine;

    plugin.settings = {
        accessToken: "token",
        tasks: parentDidaId
            ? [{
                id: "local-parent",
                didaId: parentDidaId,
                title: "Parent",
                projectId: parentProjectId,
                projectName: parentProjectName,
                status: 0
            }]
            : [],
        projects: [],
        projectCatalog: [
            { id: "p1", name: "Project One", isArchived: false, isLocalOnly: false },
            { id: "p2", name: "Project Two", isArchived: false, isLocalOnly: false }
        ],
        projectIcons: {},
        enableIndentedSubtasks: options.enableIndentedSubtasks === true
    };
    plugin.app = {
        workspace: {
            getActiveFile: () => ({ path: "Plan.md" })
        }
    };
    (globalThis as any).navigator = { onLine: true };
    (globalThis as any).window = { addEventListener() { } };
    plugin.nativeTaskSyncManager = new NativeTaskSyncManager(plugin);
    plugin.apiClient = {
        buildApiUrl: (path: string) => path,
        makeAuthenticatedRequest: async (_url: string, requestOptions: any) => {
            const body = JSON.parse(requestOptions.body);
            requests.push(body);
            return {
                ok: true,
                json: async () => {
                    const response: any = {
                        id: "child123",
                        projectId: body.projectId || "inbox"
                    };
                    response.parentId = options.responseParentId !== undefined
                        ? options.responseParentId
                        : body.parentId || null;
                    return response;
                }
            };
        }
    };
    plugin.saveSettings = async () => { };
    plugin.refreshTaskView = () => { };
    plugin.t = (key: string) => key;

    const editor = {
        getValue: () => content,
        setLine: (_lineNumber: number, line: string) => {
            updatedLine = line;
        }
    };

    return {
        plugin,
        editor,
        requests,
        taskLine,
        cursor: { line: hasParent ? 1 : 0, ch: 0 },
        getUpdatedLine: () => updatedLine
    };
}

async function run() {
    try {
        {
            const { plugin, editor, requests, taskLine, cursor, getUpdatedLine } = makePlugin({ parentDidaId: "parent123", enableIndentedSubtasks: true });
            await plugin.syncTaskToDidaList(editor, cursor, taskLine);

            assert.equal(requests.length, 1);
            assert.equal(requests[0].parentId, "parent123");
            assert.equal(requests[0].projectId, "p1");
            const child = plugin.settings.tasks.find((task: any) => task.didaId === "child123");
            assert.equal(child.parentId, "parent123");
            assert.equal(child.projectId, "p1");
            assert.equal(child.projectName, "Project One");
            assert.match(getUpdatedLine(), /didaId=child123/);
        }

        {
            const { plugin, editor, requests, taskLine, cursor } = makePlugin({ parentDidaId: "parent123" });
            await plugin.syncTaskToDidaList(editor, cursor, taskLine);

            assert.equal(requests.length, 1);
            assert.equal("parentId" in requests[0], false);
            assert.equal(plugin.settings.tasks[1].parentId, null);
        }

        {
            notices.length = 0;
            const { plugin, editor, requests, taskLine, cursor } = makePlugin({ enableIndentedSubtasks: true });
            await plugin.syncTaskToDidaList(editor, cursor, taskLine);

            assert.equal(requests.length, 0);
            assert.deepEqual(notices, ["error.parentNotSynced"]);
            assert.equal(plugin.settings.tasks.length, 0);
        }

        {
            const { plugin, editor, requests, taskLine, cursor } = makePlugin({ hasParent: false });
            await plugin.syncTaskToDidaList(editor, cursor, taskLine);

            assert.equal(requests.length, 1);
            assert.equal("parentId" in requests[0], false);
            assert.equal(plugin.settings.tasks[0].parentId, null);
        }

        {
            const { plugin, editor, taskLine, cursor } = makePlugin({
                parentDidaId: "parent123",
                enableIndentedSubtasks: true,
                responseParentId: null
            });
            await plugin.syncTaskToDidaList(editor, cursor, taskLine);

            const child = plugin.settings.tasks.find((task: any) => task.didaId === "child123");
            assert.equal(child.parentId, null);
        }

        {
            notices.length = 0;
            const { plugin, editor, requests, taskLine, cursor } = makePlugin({
                parentDidaId: "parent123",
                enableIndentedSubtasks: true,
                childProjectName: "Project Two"
            });
            await plugin.syncTaskToDidaList(editor, cursor, taskLine);

            assert.equal(requests.length, 0);
            assert.deepEqual(notices, ["error.subtaskProjectMismatch"]);
        }

        console.log("Native Markdown subtask creation tests passed");
    } finally {
        (Module as any)._load = originalLoad;
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
