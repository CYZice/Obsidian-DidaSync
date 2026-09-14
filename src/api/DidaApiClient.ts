import { Notice, Platform, requestUrl } from "obsidian";
import DidaSyncPlugin from "../main";
import { AuthUrlModal } from "../modals/AuthUrlModal";
import { DIDA_SERVICE_CONFIGS, DidaServiceConfig, DidaServiceRegion, DidaSyncSettings, OAuthCallbackMode } from "../types";
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
    private oauthRedirectUri: string | null = null;
    requestTimeoutMs: number = 20000;
    private disposed: boolean = false;

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
    }

    async dispose() {
        this.disposed = true;
        if (this.oauthTimeout) {
            clearTimeout(this.oauthTimeout);
            this.oauthTimeout = null;
        }
        await this.stopOAuthServers();
    }

    get settings(): DidaSyncSettings {
        return this.plugin.settings;
    }

    getServiceRegion(): DidaServiceRegion {
        return this.settings.serviceRegion === "ticktick" ? "ticktick" : "dida365";
    }

    getServiceConfig(): DidaServiceConfig {
        return DIDA_SERVICE_CONFIGS[this.getServiceRegion()];
    }

    buildApiUrl(path: string): string {
        return this.getServiceConfig().apiBaseUrl + (path.startsWith("/") ? path : `/${path}`);
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
            new Notice(this.plugin.t("error.clientCredentialsMissing"));
            return;
        }
        if (this.oauthInProgress) {
            // A previous browser flow may have lost its callback. Re-authorizing
            // should replace that stale attempt instead of blocking the user.
            await this.stopOAuthServers();
            if (this.oauthTimeout) {
                clearTimeout(this.oauthTimeout);
                this.oauthTimeout = null;
            }
            this.oauthInProgress = false;
            this.oauthRedirectUri = null;
        }

        try {
            this.oauthInProgress = true;
            this.oauthRedirectUri = this.getRedirectUri();
            this.plugin.updateStatusBar(this.plugin.t("status.authorizing"));
            if (!Platform.isMobile) {
                await this.startOAuthServer();
            }
            const redirectUri = this.oauthRedirectUri;
            const url = this.buildAuthUrlForRedirect(redirectUri);
            await this.openAuthUrl(url, redirectUri);
            if (Platform.isMobile) {
                this.oauthInProgress = false;
                this.plugin.updateStatusBar(this.plugin.t("status.waitingForCode"));
            }
        } catch (t: any) {
            new Notice(this.plugin.t("notice.oauthStartFailed", { message: t?.message || t }));
            this.plugin.updateStatusBar(this.plugin.t("status.authFailed"));
            this.cleanupOAuthServer();
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
            scope: this.getServiceConfig().scope
        });
        return this.getServiceConfig().authUrl + "?" + params.toString();
    }

    async startManualOAuthFlow() {
        if (!this.settings.clientId || !this.settings.clientSecret) {
            new Notice(this.plugin.t("error.clientCredentialsMissing"));
            return;
        }
        this.oauthRedirectUri = this.getRedirectUri();
        const redirectUri = this.getRedirectUri();
        const url = this.buildAuthUrlForRedirect(redirectUri);
        await this.openAuthUrl(url, redirectUri);
        this.plugin.updateStatusBar(this.plugin.t("status.waitingForCode"));
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
        new AuthUrlModal(this.plugin.app, this.plugin, url, redirectUri).open();
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
            onCode: code => { void this.handleOAuthCallback(code, this.oauthRedirectUri || this.getRedirectUri()); },
            onError: error => this.handleOAuthError(error),
            translate: (key, params) => this.plugin.t(key, params)
        });
        this.oauthTimeout = setTimeout(() => this.handleOAuthError(this.plugin.t("error.oauthTimeout")), 600000);
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
                                    <head><title>${this.plugin.t("oauthPage.failTitle")}</title></head>
                                    <body>
                                        <h1>${this.plugin.t("oauthPage.failTitle")}</h1>
                                        <p>${this.plugin.t("oauthPage.errorDetail", { error })}</p>
                                        <p>${this.plugin.t("oauthPage.failHint")}</p>
                                    </body>
                                </html>
                            `);
                            this.handleOAuthError(error);
                        } else if (code) {
                            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                            res.end(`
                                <html>
                                    <head><title>${this.plugin.t("oauthPage.successTitle")}</title></head>
                                    <body>
                                        <h1>${this.plugin.t("oauthPage.successHeading")}</h1>
                                        <p>${this.plugin.t("oauthPage.successHint")}</p>
                                        <script>setTimeout(() => window.close(), 3000);</script>
                                    </body>
                                </html>
                            `);
                            this.handleOAuthCallback(code);
                        } else {
                            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                            res.end(`
                                <html>
                                    <head><title>${this.plugin.t("oauthPage.missingCodeTitle")}</title></head>
                                    <body>
                                        <h1>${this.plugin.t("oauthPage.missingCodeTitle")}</h1>
                                        <p>${this.plugin.t("oauthPage.missingCodeHint")}</p>
                                    </body>
                                </html>
                            `);
                            this.handleOAuthError(this.plugin.t("error.noAuthCode"));
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
                    fail(new Error(this.plugin.t("error.callbackServerStart", { host: hostLabel, port: this.settings.serverPort, message: err.message })));
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
                this.handleOAuthError(this.plugin.t("error.oauthTimeout"));
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
        this.oauthRedirectUri = null;
    }

    async handleOAuthCallback(code: string, redirectUri: string = this.oauthRedirectUri || this.getRedirectUri()) {
        try {
            const tokens = await this.exchangeCodeForToken(code.trim(), redirectUri);
            this.settings.accessToken = tokens.access_token;
            this.settings.refreshToken = tokens.refresh_token || this.settings.refreshToken;
            await this.plugin.saveSettings();
            new Notice(this.plugin.t("notice.oauthSuccess"));
            this.plugin.updateStatusBar(this.plugin.t("status.connected"));
            this.plugin.setupAutoSync();
        } catch (t: any) {
            new Notice(this.plugin.t("notice.authFailedDetail", { message: t?.message || t }));
            this.plugin.updateStatusBar(this.plugin.t("status.authFailed"));
        } finally {
            this.cleanupOAuthServer();
        }
    }

    handleOAuthError(error: string) {
        new Notice(this.plugin.t("notice.oauthFailed", { error }));
        this.plugin.updateStatusBar(this.plugin.t("status.authFailed"));
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

        const res = await this.requestForm(this.getServiceConfig().tokenUrl, data);
        if (res.ok) return await res.json();
        const detail = await res.text();
        if (res.status === 400 && /invalid_grant/i.test(detail) && /redirect/i.test(detail)) {
            throw new Error(this.plugin.t("error.oauthRedirectMismatch", { redirectUri }));
        }
        throw new Error(this.plugin.t("error.tokenRequestFailed", { status: res.status, detail }));
    }

    async refreshAccessToken(): Promise<any> {
        if (!this.settings.refreshToken) throw new Error(this.plugin.t("error.noRefreshToken"));

        const data = new URLSearchParams({
            grant_type: "refresh_token",
            client_id: this.settings.clientId,
            client_secret: this.settings.clientSecret,
            refresh_token: this.settings.refreshToken
        }).toString();

        const res = await this.requestForm(this.getServiceConfig().tokenUrl, data);
        if (!res.ok) throw new Error(this.plugin.t("error.tokenRefreshFailed"));
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
        if (!this.settings.accessToken) throw new Error(this.plugin.t("error.notAuthenticated"));

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
            this.plugin.updateStatusBar(this.plugin.t("status.disconnected"));
            throw new Error(this.plugin.t("error.authExpired"));
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
        if (this.disposed) throw new Error(this.plugin.t("error.requestCancelled"));
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
            const response = await Promise.race([
                requestUrl({
                    url,
                    method: options.method || "GET",
                    body: options.body || undefined,
                    headers: options.headers || {},
                    throw: false
                }),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error(this.plugin.t("error.requestTimeout", { seconds: Math.round(this.requestTimeoutMs / 1000) }))), this.requestTimeoutMs);
                })
            ]);
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
            throw new Error(this.plugin.t("error.networkError", { message: e?.message || e }));
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    async getProjects(): Promise<any[]> {
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl("/project"));
        if (res.ok) return await res.json();
        throw new Error("Failed to fetch projects");
    }

    async getProjectTasks(projectId: string): Promise<any[]> {
        for (const url of [this.buildApiUrl(`/project/${projectId}/task`), this.buildApiUrl(`/project/${projectId}/data`), this.buildApiUrl(`/task?projectId=${projectId}`)]) {
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
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl("/task"), {
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
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl(`/task/${taskId}`), {
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
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl(`/project/${projectId}/task/${taskId}`), {
            method: "DELETE"
        });
        if (!res.ok) throw new Error("Failed to delete task");
    }

    async completeTask(projectId: string, taskId: string): Promise<void> {
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl(`/project/${projectId}/task/${taskId}/complete`), {
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
        const arrayRes = await this.makeAuthenticatedRequest(this.buildApiUrl("/task/move"), {
            method: "POST",
            body: JSON.stringify([operation])
        });
        const arrayBody = await this.readResponseBody(arrayRes);
        if (arrayRes.ok && this.isMoveResultSuccessful(arrayBody.data, taskId)) return arrayBody.data;

        const objectRes = await this.makeAuthenticatedRequest(this.buildApiUrl("/task/move"), {
            method: "POST",
            body: JSON.stringify(operation)
        });
        const objectBody = await this.readResponseBody(objectRes);
        if (objectRes.ok && this.isMoveResultSuccessful(objectBody.data, taskId)) return objectBody.data;
        throw new Error(this.plugin.t("error.moveTaskFailed", { arrayStatus: arrayRes.status, arrayDetail: arrayBody.text || JSON.stringify(arrayBody.data), objectStatus: objectRes.status, objectDetail: objectBody.text || JSON.stringify(objectBody.data) }));
    }

    async moveTasks(operations: Array<{ fromProjectId: string; toProjectId: string; taskId: string }>): Promise<any[]> {
        if (!Array.isArray(operations) || operations.length === 0) throw new Error("Move operations are required");
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl("/task/move"), {
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
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl("/task/completed"), {
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
        const res = await this.makeAuthenticatedRequest(this.buildApiUrl("/task/filter"), {
            method: "POST",
            body: JSON.stringify(payload)
        });
        if (res.ok) return await res.json();
        throw await res.text();
    }
}
