import assert from "node:assert/strict";
import Module from "node:module";

const requests: any[] = [];
let queuedResponses: any[] = [];
const platform = { isMobile: false };
let authUrlModalOpenCount = 0;
const originalLoad = (Module as any)._load;

(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "obsidian") {
        return {
            Notice: class Notice {
                constructor(_message?: string) { }
            },
            Platform: platform,
            requestUrl: async (options: any) => {
                requests.push(options);
                const response = queuedResponses.shift();
                if (response instanceof Error) throw response;
                return response || { status: 200, text: "{}", json: {} };
            }
        };
    }
    if (request === "../main" || request.endsWith("/main")) {
        return class DidaSyncPlugin { };
    }
    if (request.includes("AuthUrlModal")) {
        return { AuthUrlModal: class AuthUrlModal { open() { authUrlModalOpenCount++; } } };
    }
    return originalLoad.call(this, request, parent, isMain);
};

async function run() {
    const { DidaApiClient } = require("../src/api/DidaApiClient");
    const plugin = {
        settings: {
            clientId: "client-id",
            clientSecret: "client-secret",
            accessToken: "access-old",
            refreshToken: "refresh-old",
            serverPort: 8765,
            oauthCallbackMode: "ipv4"
        },
        saveCount: 0,
        status: "",
        async saveSettings() { this.saveCount++; },
        updateStatusBar(value: string) { this.status = value; },
        setupAutoSync() { },
        getUserTimeZone() { return "Asia/Shanghai"; }
    };
    const client = new DidaApiClient(plugin as any);

    assert.equal(client.getRedirectHost(), "127.0.0.1");
    assert.equal(client.getLocalRedirectUri(), "http://127.0.0.1:8765/callback");
    const authUrl = client.buildAuthUrl();
    assert.match(authUrl, /^https:\/\/dida365\.com\/oauth\/authorize\?/);
    assert.match(authUrl, /client_id=client-id/);
    assert.match(authUrl, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A8765%2Fcallback/);
    assert.match(authUrl, /scope=tasks%3Awrite\+tasks%3Aread/);

    const originalWindow = (globalThis as any).window;

    platform.isMobile = false;
    let desktopWindowOpenCalls = 0;
    (globalThis as any).window = {
        open: () => {
            desktopWindowOpenCalls++;
            return null;
        }
    };
    await (client as any).openAuthUrl("https://example.test/oauth");
    assert.equal(desktopWindowOpenCalls, 1, "桌面端首选打开方式失败后应尝试 window.open 回退");
    assert.equal(authUrlModalOpenCount, 0, "桌面端回退打开成功时不应误报手动链接");

    platform.isMobile = true;
    assert.equal(client.getRedirectUri(), "http://127.0.0.1:8765/callback");
    (globalThis as any).window = { open: () => null };
    await (client as any).openAuthUrl("https://example.test/oauth");
    assert.equal(authUrlModalOpenCount, 0, "移动端 window.open 返回 null 不应误报打开失败");
    (globalThis as any).window.open = () => { throw new Error("open failed"); };
    await (client as any).openAuthUrl("https://example.test/oauth");
    assert.equal(authUrlModalOpenCount, 1, "移动端浏览器调用抛错时应显示手动链接");
    (globalThis as any).window = originalWindow;
    let openedRedirect = "";
    (client as any).openAuthUrl = async (_url: string, redirectUri?: string) => { openedRedirect = redirectUri || client.getRedirectUri(); };
    (client as any).startOAuthServer = async () => { throw new Error("移动端不应启动本地 OAuth 服务"); };
    await client.startOAuthFlow();
    assert.equal(openedRedirect, "http://127.0.0.1:8765/callback");
    await client.startManualOAuthFlow();
    assert.equal(openedRedirect, "http://127.0.0.1:8765/callback");
    queuedResponses = [{ status: 200, text: "{}", json: { access_token: "mobile-access", refresh_token: "mobile-refresh" } }];
    await client.handleOAuthCallback("mobile-code");
    assert.equal(plugin.settings.accessToken, "mobile-access");
    assert.match(requests.at(-1).body, /code=mobile-code/);
    assert.match(requests.at(-1).body, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A8765%2Fcallback/);
    platform.isMobile = false;
    plugin.settings.accessToken = "access-old";
    plugin.settings.refreshToken = "refresh-old";
    plugin.saveCount = 0;

    queuedResponses = [{ status: 200, text: "{\"access_token\":\"access-new\",\"refresh_token\":\"refresh-new\"}", json: { access_token: "access-new", refresh_token: "refresh-new" } }];
    const token = await client.refreshAccessToken();
    assert.equal(token.access_token, "access-new");
    assert.equal(plugin.settings.accessToken, "access-new");
    assert.equal(plugin.settings.refreshToken, "refresh-new");
    assert.equal(plugin.saveCount, 1);
    assert.equal(requests.at(-1).method, "POST");
    assert.match(requests.at(-1).body, /grant_type=refresh_token/);

    plugin.settings.accessToken = "expired";
    plugin.settings.refreshToken = "refresh-new";
    queuedResponses = [
        { status: 401, text: "unauthorized", json: {} },
        { status: 200, text: "{\"access_token\":\"after-refresh\"}", json: { access_token: "after-refresh" } },
        { status: 200, text: "{\"ok\":true}", json: { ok: true } }
    ];
    const res = await client.makeAuthenticatedRequest("https://example.test/tasks", { headers: { "X-Test": "1" } });
    assert.equal(res.status, 200);
    assert.equal(plugin.settings.accessToken, "after-refresh");
    assert.equal(requests.at(-1).headers.Authorization, "Bearer after-refresh");
    assert.equal(requests.at(-1).headers["X-Test"], "1");

    plugin.settings.accessToken = "expired-again";
    plugin.settings.refreshToken = "refresh-valid";
    const saveCountBeforeRetryFailure = plugin.saveCount;
    queuedResponses = [
        { status: 401, text: "unauthorized", json: {} },
        { status: 200, text: "{\"access_token\":\"refreshed-before-network-error\"}", json: { access_token: "refreshed-before-network-error" } },
        new Error("retry DNS failed")
    ];
    await assert.rejects(
        () => client.makeAuthenticatedRequest("https://example.test/retry-fails"),
        /网络请求错误: retry DNS failed/
    );
    assert.equal(plugin.settings.accessToken, "refreshed-before-network-error");
    assert.equal(plugin.settings.refreshToken, "refresh-valid");
    assert.equal(plugin.saveCount, saveCountBeforeRetryFailure + 1);

    queuedResponses = [new Error("DNS failed")];
    await assert.rejects(
        () => (client as any).requestUrlLike("https://example.test/fail", {}),
        /网络请求错误: DNS failed/
    );

    requests.length = 0;
    queuedResponses = [{ status: 200, text: "[{\"taskId\":\"task-1\"}]", json: [{ taskId: "task-1" }] }];
    await client.moveTask("p1", "p2", "task-1");
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].body), [{ fromProjectId: "p1", toProjectId: "p2", taskId: "task-1" }]);

    requests.length = 0;
    queuedResponses = [
        { status: 200, text: "[]", json: [] },
        { status: 200, text: "{\"id\":\"task-2\"}", json: { id: "task-2" } }
    ];
    await client.moveTask("inbox", "p2", "task-2");
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[0].body), [{ fromProjectId: "inbox", toProjectId: "p2", taskId: "task-2" }]);
    assert.deepEqual(JSON.parse(requests[1].body), { fromProjectId: "inbox", toProjectId: "p2", taskId: "task-2" });

    requests.length = 0;
    queuedResponses = [{ status: 200, text: "[]", json: [] }];
    await client.filterTasks({ kind: ["NOTE"], status: [0], projectIds: ["p-note"] });
    assert.equal(requests.at(-1).url, "https://api.dida365.com/open/v1/task/filter");
    assert.deepEqual(JSON.parse(requests.at(-1).body), { projectIds: ["p-note"], status: [0], kind: ["NOTE"] });

    requests.length = 0;
    queuedResponses = [{ status: 200, text: "{\"success\":true}", json: { success: true } }];
    await client.moveTask("p1", "inbox", "task-3");
    assert.deepEqual(JSON.parse(requests[0].body), [{ fromProjectId: "p1", toProjectId: "inbox", taskId: "task-3" }]);

    requests.length = 0;
    queuedResponses = [
        { status: 200, text: "{}", json: {} },
        { status: 200, text: "[]", json: [] }
    ];
    await assert.rejects(
        () => client.moveTask("p1", "p2", "task-4"),
        /移动任务失败/
    );

    console.log("DidaApiClient OAuth and request tests passed");
}

run()
    .finally(() => {
        (Module as any)._load = originalLoad;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
