import { Notice, Platform, requestUrl } from "obsidian";
import DidaSyncPlugin from "../main";
import { AuthUrlModal } from "../modals/AuthUrlModal";
import { DidaSyncSettings, OAUTH_CONFIG, OAuthCallbackMode } from "../types";
import { formatCompletedTime } from "../utils";

type ResponseLike = {
    ok: boolean;
    status: number;
    json: () => Promise<any>;
    text: () => Promise<string>;
};

export class DidaApiClient {
    plugin: DidaSyncPlugin;
    oauthServers: any[] = [];
    desktopOAuthServer: { close(): Promise<void> } | null = null;
    oauthTimeout: ReturnType<typeof setTimeout> | null = null;
    oauthInProgress: boolean = false;

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
    }

    get settings(): DidaSyncSettings {
        return this.plugin.settings;
    }

    getCallbackMode(): OAuthCallbackMode {
        return this.settings.oauthCallbackMode === "ipv4" ? "ipv4" : "localhost";
    }

    getRedirectHost() {
        return this.getCallbackMode() === "ipv4" ? "127.0.0.1" : "localhost";
    }

    getRedirectUri() {
        return this.getLocalRedirectUri();
    }

    getLocalRedirectUri() {
        return `http://${this.getRedirectHost()}:${this.settings.serverPort}/callback`;
    }

    getCallbackBaseUrl() {
        return this.getLocalRedirectUri().replace("/callback", "");
    }

    getListenTargets() {
        if (this.getCallbackMode() === "ipv4") {
            return [{ host: "127.0.0.1", ipv6Only: false }];
        }

        return [
            { host: "127.0.0.1", ipv6Only: false },
            { host: "::1", ipv6Only: true }
        ];
    }

    async startOAuthFlow() {
        if (!this.settings.clientId || !this.settings.clientSecret) {
            new Notice("请先在设置中配置Client ID和Client Secret");
            return;
        }
        if (this.oauthInProgress) {
            new Notice("OAuth认证正在进行中...");
            return;
        }

        try {
            this.oauthInProgress = true;
            this.plugin.updateStatusBar("认证中...");
            if (!Platform.isMobile) {
                await this.startOAuthServer();
            }
            const redirectUri = this.getRedirectUri();
            const url = this.buildAuthUrlForRedirect(redirectUri);
            await this.openAuthUrl(url, redirectUri);
            if (Platform.isMobile) {
                this.oauthInProgress = false;
                this.plugin.updateStatusBar("等待授权码");
            }
        } catch (t: any) {
            new Notice("OAuth认证启动失败: " + (t?.message || t));
            this.plugin.updateStatusBar("认证失败");
            this.oauthInProgress = false;
        }
    }

    buildAuthUrl() {
        return this.buildAuthUrlForRedirect(this.getRedirectUri());
    }

    buildAuthUrlForRedirect(redirectUri: string) {
        const params = new URLSearchParams({
            client_id: this.settings.clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: OAUTH_CONFIG.scope
        });
        return OAUTH_CONFIG.authUrl + "?" + params.toString();
    }

    async startManualOAuthFlow() {
        if (!this.settings.clientId || !this.settings.clientSecret) {
            new Notice("请先在设置中配置Client ID和Client Secret");
            return;
        }
        const redirectUri = this.getRedirectUri();
        const url = this.buildAuthUrlForRedirect(redirectUri);
        await this.openAuthUrl(url, redirectUri);
        this.plugin.updateStatusBar("等待授权码");
    }

    private async openAuthUrl(url: string, redirectUri: string = this.getRedirectUri()) {
        try {
            if (!Platform.isMobile) {
                const electron = await import("electron");
                await electron.shell.openExternal(url);
                return;
            }
        } catch (e) { }
        try {
            window.open(url, "_blank");
            return;
        } catch (e) { }
        new AuthUrlModal(this.plugin.app, url, redirectUri).open();
    }

    async startOAuthServer() {
        if (this.oauthTimeout) {
            clearTimeout(this.oauthTimeout);
            this.oauthTimeout = null;
        }
        await this.stopOAuthServers();
        const { startDesktopOAuthCallbackServer } = await import("../platform/DesktopOAuthCallbackServer");
        this.desktopOAuthServer = await startDesktopOAuthCallbackServer({
            port: this.settings.serverPort,
            callbackBaseUrl: this.getCallbackBaseUrl(),
            listenTargets: this.getListenTargets(),
            onCode: code => { void this.handleOAuthCallback(code); },
            onError: error => this.handleOAuthError(error)
        });
        this.oauthTimeout = setTimeout(() => this.handleOAuthError("OAuth 认证超时"), 600000);
        return;
        /* Legacy inline server implementation retained only as commented migration context.
        if (this.oauthTimeout) {
            clearTimeout(this.oauthTimeout);
            this.oauthTimeout = null;
        }
        await this.stopOAuthServers();
        const http = await import("http");
        return new Promise<void>((resolve, reject) => {
            const startedServers: any[] = [];
            let pending = this.getListenTargets().length;
            let settled = false;

            const requestHandler = (req: any, res: any) => {
                try {
                    var url = new URL(req.url || "", this.getCallbackBaseUrl());
                    if ("/callback" === url.pathname) {
                        const code = url.searchParams.get("code");
                        const error = url.searchParams.get("error");

                        if (error) {
                            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                            res.end(`
                                <html>
                                    <head><title>OAuth认证失败</title></head>
                                    <body>
                                        <h1>OAuth认证失败</h1>
                                        <p>错误: ${error}</p>
                                        <p>请关闭此页面并重试。</p>
                                    </body>
                                </html>
                            `);
                            this.handleOAuthError(error);
                        } else if (code) {
                            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                            res.end(`
                                <html>
                                    <head><title>认证成功</title></head>
                                    <body>
                                        <h1>OAuth认证成功!</h1>
                                        <p>您可以关闭此页面，返回 Obsidian 继续使用。</p>
                                        <script>setTimeout(() => window.close(), 3000);</script>
                                    </body>
                                </html>
                            `);
                            this.handleOAuthCallback(code);
                        } else {
                            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                            res.end(`
                                <html>
                                    <head><title>认证失败</title></head>
                                    <body>
                                        <h1>认证失败</h1>
                                        <p>未收到授权码，请重试。</p>
                                    </body>
                                </html>
                            `);
                            this.handleOAuthError("未收到授权码");
                        }
                    } else {
                        res.writeHead(404, { "Content-Type": "text/plain" });
                        res.end("Not Found");
                    }
                } catch (e) {
                    // Ignore errors during request handling
                }
            };

            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                if (this.oauthTimeout) {
                    clearTimeout(this.oauthTimeout);
                    this.oauthTimeout = null;
                }
                this.closeServers(startedServers);
                this.oauthServers = [];
                reject(error);
            };

            const succeed = () => {
                if (settled) return;
                settled = true;
                this.oauthServers = startedServers;
                resolve();
            };

            this.getListenTargets().forEach((target) => {
                const server = http.createServer(requestHandler);
                startedServers.push(server);
                server.once("error", (err: any) => {
                    const hostLabel = target.host.includes(":") ? `[${target.host}]` : target.host;
                    fail(new Error(`无法启动 OAuth 回调服务 ${hostLabel}:${this.settings.serverPort}: ${err.message}`));
                });
                server.listen({
                    port: this.settings.serverPort,
                    host: target.host,
                    ipv6Only: target.ipv6Only
                }, () => {
                    pending -= 1;
                    if (pending === 0) {
                        succeed();
                    }
                });
            });

            this.oauthTimeout = setTimeout(() => {
                this.handleOAuthError("OAuth认证超时");
            }, 600000);
        });
    }

        */
    }

    closeServers(servers: any[]) {
        for (const server of servers) {
            try {
                server.close();
            } catch (e) { }
        }
    }

    async stopOAuthServers() {
        const desktopServer = this.desktopOAuthServer;
        this.desktopOAuthServer = null;
        if (desktopServer) await desktopServer.close();
        if (this.oauthServers.length === 0) return;
        const servers = this.oauthServers;
        this.oauthServers = [];
        await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
            try {
                server.close(() => resolve());
            } catch (e) {
                resolve();
            }
        })));
    }

    cleanupOAuthServer() {
        if (this.oauthTimeout) {
            clearTimeout(this.oauthTimeout);
            this.oauthTimeout = null;
        }
        this.closeServers(this.oauthServers);
        this.oauthServers = [];
        void this.stopOAuthServers();
        this.oauthInProgress = false;
    }

    async handleOAuthCallback(code: string, redirectUri: string = this.getRedirectUri()) {
        try {
            const tokens = await this.exchangeCodeForToken(code.trim(), redirectUri);
            this.settings.accessToken = tokens.access_token;
            this.settings.refreshToken = tokens.refresh_token || this.settings.refreshToken;
            await this.plugin.saveSettings();
            new Notice("OAuth认证成功!");
            this.plugin.updateStatusBar("已连接");
            this.plugin.setupAutoSync();
        } catch (t: any) {
            new Notice("认证失败: " + (t?.message || t));
            this.plugin.updateStatusBar("认证失败");
        } finally {
            this.cleanupOAuthServer();
        }
    }

    handleOAuthError(error: string) {
        new Notice("OAuth认证失败: " + error);
        this.plugin.updateStatusBar("认证失败");
        this.cleanupOAuthServer();
    }

    async exchangeCodeForToken(code: string, redirectUri: string = this.getRedirectUri()): Promise<any> {
        const data = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: this.settings.clientId,
            client_secret: this.settings.clientSecret,
            code,
            redirect_uri: redirectUri
        }).toString();

        const res = await this.requestForm(OAUTH_CONFIG.tokenUrl, data);
        if (res.ok) return await res.json();
        throw new Error(`Token请求失败: ${res.status} ` + await res.text());
    }

    async refreshAccessToken(): Promise<any> {
        if (!this.settings.refreshToken) throw new Error("没有refresh token");

        const data = new URLSearchParams({
            grant_type: "refresh_token",
            client_id: this.settings.clientId,
            client_secret: this.settings.clientSecret,
            refresh_token: this.settings.refreshToken
        }).toString();

        const res = await this.requestForm(OAUTH_CONFIG.tokenUrl, data);
        if (!res.ok) throw new Error("Token刷新失败");
        const parsed = await res.json();
        this.settings.accessToken = parsed.access_token;
        if (parsed.refresh_token) {
            this.settings.refreshToken = parsed.refresh_token;
        }
        await this.plugin.saveSettings();
        return parsed;
    }

    private async requestForm(url: string, body: string): Promise<ResponseLike> {
        return this.requestUrlLike(url, {
            method: "POST",
            body,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            }
        });
    }

    async makeAuthenticatedRequest(urlStr: string, options: any = {}): Promise<ResponseLike> {
        if (!this.settings.accessToken) throw new Error("未认证，请先进行OAuth认证");

        const requestOptions = {
            method: options.method || "GET",
            body: options.body || "",
            headers: {
                Authorization: "Bearer " + this.settings.accessToken,
                "Content-Type": "application/json",
                "User-Agent": "Didasync-Plugin/1.0",
                ...options.headers
            }
        };

        let res = await this.requestUrlLike(urlStr, requestOptions);
        if (res.status !== 401) return res;

        try {
            await this.refreshAccessToken();
        } catch (e) {
            this.settings.accessToken = "";
            this.settings.refreshToken = "";
            await this.plugin.saveSettings();
            this.plugin.updateStatusBar("未连接");
            throw new Error("认证已过期，请重新进行OAuth认证");
        }

        res = await this.requestUrlLike(urlStr, {
            ...requestOptions,
            headers: {
                ...requestOptions.headers,
                Authorization: "Bearer " + this.settings.accessToken
            }
        });
        return res;
    }

    private async requestUrlLike(url: string, options: { method?: string; body?: string; headers?: Record<string, string> }): Promise<ResponseLike> {
        try {
            const response = await requestUrl({
                url,
                method: options.method || "GET",
                body: options.body || undefined,
                headers: options.headers || {},
                throw: false
            });
            const text = typeof response.text === "string" ? response.text : "";
            return {
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                json: async () => {
                    if (response.json !== undefined) return response.json;
                    return JSON.parse(text);
                },
                text: async () => text
            };
        } catch (e: any) {
            throw new Error("网络请求错误: " + (e?.message || e));
        }
    }

    async getProjects(): Promise<any[]> {
        const res = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/project");
        if (res.ok) return await res.json();
        throw new Error("Failed to fetch projects");
    }

    async getProjectTasks(projectId: string): Promise<any[]> {
        for (const url of [`https://api.dida365.com/open/v1/project/${projectId}/task`, `https://api.dida365.com/open/v1/project/${projectId}/data`, `https://api.dida365.com/open/v1/task?projectId=${projectId}`]) {
            try {
                const res = await this.makeAuthenticatedRequest(url);
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data)) return data;
                    if (data && data.tasks && Array.isArray(data.tasks)) return data.tasks;
                    if (data && data.data && Array.isArray(data.data)) return data.data;
                }
            } catch (e) { }
        }
        return [];
    }

    async getAllTasks(): Promise<any[]> {
        return [];
    }

    async createTask(taskData: any): Promise<any> {
        if (taskData && taskData.dueDate && typeof taskData.dueDate === "string" && taskData.dueDate.endsWith("Z")) {
            taskData.dueDate = taskData.dueDate.replace("Z", "+0000");
        }
        if (taskData && taskData.startDate && typeof taskData.startDate === "string" && taskData.startDate.endsWith("Z")) {
            taskData.startDate = taskData.startDate.replace("Z", "+0000");
        }
        if (taskData && taskData.isAllDay) {
            taskData.timeZone = taskData.timeZone || this.plugin.getUserTimeZone();
        }
        const res = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task", {
            method: "POST",
            body: JSON.stringify(taskData)
        });
        if (res.ok) return await res.json();
        throw await res.text();
    }

    async updateTask(taskId: string, taskData: any): Promise<any> {
        if (taskData && taskData.dueDate && typeof taskData.dueDate === "string" && taskData.dueDate.endsWith("Z")) {
            taskData.dueDate = taskData.dueDate.replace("Z", "+0000");
        }
        if (taskData && taskData.startDate && typeof taskData.startDate === "string" && taskData.startDate.endsWith("Z")) {
            taskData.startDate = taskData.startDate.replace("Z", "+0000");
        }
        if (taskData && taskData.isAllDay) {
            taskData.timeZone = taskData.timeZone || this.plugin.getUserTimeZone();
        }
        if (taskData && taskData.status === 2 && !taskData.completedTime) {
            taskData.completedTime = formatCompletedTime();
        }
        const res = await this.makeAuthenticatedRequest(`https://api.dida365.com/open/v1/task/${taskId}`, {
            method: "POST",
            body: JSON.stringify(taskData)
        });
        if (res.ok) return await res.json();
        throw await res.text();
    }

    async updateNote(noteId: string, noteData: any): Promise<any> {
        return this.updateTask(noteId, {
            ...noteData,
            kind: "NOTE"
        });
    }

    async deleteTask(projectId: string, taskId: string): Promise<void> {
        const res = await this.makeAuthenticatedRequest(`https://api.dida365.com/open/v1/project/${projectId}/task/${taskId}`, {
            method: "DELETE"
        });
        if (!res.ok) throw new Error("Failed to delete task");
    }

    async completeTask(projectId: string, taskId: string): Promise<void> {
        const res = await this.makeAuthenticatedRequest(`https://api.dida365.com/open/v1/project/${projectId}/task/${taskId}/complete`, {
            method: "POST"
        });
        if (!res.ok) throw new Error("Failed to complete task");
    }

    private async readResponseBody(res: ResponseLike): Promise<{ data: any; text: string }> {
        const text = await res.text().catch(() => "");
        if (text) {
            try {
                return { data: JSON.parse(text), text };
            } catch (_error) {
                return { data: text, text };
            }
        }
        try {
            const data = await res.json();
            return { data, text: typeof data === "string" ? data : JSON.stringify(data || "") };
        } catch (_error) {
            return { data: null, text: "" };
        }
    }

    private isMoveResultSuccessful(data: any, taskId: string): boolean {
        if (data === undefined || data === null || data === "") return false;
        const items = Array.isArray(data) ? data : [data];
        if (items.length === 0) return false;
        return items.some((item) => {
            if (item === taskId) return true;
            if (!item || typeof item !== "object") return false;
            if (item.error || item.errorCode || item.errorMessage || item.success === false) return false;
            const id = item.id || item.taskId;
            if (id) return id === taskId;
            return item.success === true || !!item.etag;
        });
    }

    async moveTask(fromProjectId: string, toProjectId: string, taskId: string): Promise<any> {
        const operation = { fromProjectId, toProjectId, taskId };
        const arrayRes = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task/move", {
            method: "POST",
            body: JSON.stringify([operation])
        });
        const arrayBody = await this.readResponseBody(arrayRes);
        if (arrayRes.ok && this.isMoveResultSuccessful(arrayBody.data, taskId)) return arrayBody.data;

        const objectRes = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task/move", {
            method: "POST",
            body: JSON.stringify(operation)
        });
        const objectBody = await this.readResponseBody(objectRes);
        if (objectRes.ok && this.isMoveResultSuccessful(objectBody.data, taskId)) return objectBody.data;
        throw new Error(`移动任务失败: array ${arrayRes.status} ${arrayBody.text || JSON.stringify(arrayBody.data)}; object ${objectRes.status} ${objectBody.text || JSON.stringify(objectBody.data)}`);
    }

    async moveTasks(operations: Array<{ fromProjectId: string; toProjectId: string; taskId: string }>): Promise<any[]> {
        if (!Array.isArray(operations) || operations.length === 0) throw new Error("Move operations are required");
        const res = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task/move", {
            method: "POST",
            body: JSON.stringify(operations)
        });
        if (res.ok) return await res.json();
        throw await res.text();
    }

    async getCompletedTasks(filters: {
        projectIds?: string[];
        startDate?: string;
        endDate?: string;
    } = {}): Promise<any[]> {
        const payload: any = {};
        if (Array.isArray(filters.projectIds) && filters.projectIds.length > 0) payload.projectIds = filters.projectIds;
        if (filters.startDate) payload.startDate = filters.startDate;
        if (filters.endDate) payload.endDate = filters.endDate;
        const res = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task/completed", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        if (res.ok) return await res.json();
        throw await res.text();
    }

    async filterTasks(filters: {
        projectIds?: string[];
        startDate?: string;
        endDate?: string;
        priority?: number[];
        tag?: string[];
        status?: number[];
        kind?: string[];
    } = {}): Promise<any[]> {
        const payload: any = {};
        if (Array.isArray(filters.projectIds) && filters.projectIds.length > 0) payload.projectIds = filters.projectIds;
        if (filters.startDate) payload.startDate = filters.startDate;
        if (filters.endDate) payload.endDate = filters.endDate;
        if (Array.isArray(filters.priority) && filters.priority.length > 0) payload.priority = filters.priority;
        if (Array.isArray(filters.tag) && filters.tag.length > 0) payload.tag = filters.tag;
        if (Array.isArray(filters.status) && filters.status.length > 0) payload.status = filters.status;
        if (Array.isArray(filters.kind) && filters.kind.length > 0) payload.kind = filters.kind;
        const res = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task/filter", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        if (res.ok) return await res.json();
        throw await res.text();
    }
}
