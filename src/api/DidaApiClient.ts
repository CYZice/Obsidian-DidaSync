import { Notice } from "obsidian";
import * as http from "http";
import * as https from "https";
import * as querystring from "querystring";
import { shell } from "electron";
import { OAUTH_CONFIG, DidaSyncSettings } from "../types";
import DidaSyncPlugin from "../main";
import { AuthUrlModal } from "../modals/AuthUrlModal";

export class DidaApiClient {
    plugin: DidaSyncPlugin;
    oauthServer: http.Server | null = null;
    oauthTimeout: NodeJS.Timeout | null = null;
    oauthInProgress: boolean = false;

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
    }

    get settings(): DidaSyncSettings {
        return this.plugin.settings;
    }

    getRedirectUri() {
        return `http://localhost:${this.settings.serverPort}/callback`;
    }

    async startOAuthFlow() {
        if (this.settings.clientId && this.settings.clientSecret) {
            if (this.oauthInProgress) {
                new Notice("OAuth认证正在进行中...");
            } else {
                try {
                    this.oauthInProgress = true;
                    this.plugin.updateStatusBar("认证中...");
                    await this.startOAuthServer();
                    var url = this.buildAuthUrl();
                    try {
                        await shell.openExternal(url);
                    } catch (t) {
                        new AuthUrlModal(this.plugin.app, url, this.getRedirectUri()).open();
                    }
                } catch (t: any) {
                    new Notice("OAuth认证启动失败: " + t.message);
                    this.plugin.updateStatusBar("认证失败");
                    this.oauthInProgress = false;
                }
            }
        } else {
            new Notice("请先在设置中配置Client ID和Client Secret");
        }
    }

    buildAuthUrl() {
        var params = new URLSearchParams({
            client_id: this.settings.clientId,
            redirect_uri: this.getRedirectUri(),
            response_type: "code",
            scope: OAUTH_CONFIG.scope
        });
        return OAUTH_CONFIG.authUrl + "?" + params.toString();
    }

    async startOAuthServer() {
        if (this.oauthServer) {
            this.oauthServer.close();
            this.oauthServer = null;
        }
        return new Promise<void>((resolve, reject) => {
            this.oauthServer = http.createServer((req, res) => {
                try {
                    var url = new URL(req.url || "", "http://localhost:" + this.settings.serverPort);
                    if ("/callback" === url.pathname) {
                        var code = url.searchParams.get("code");
                        var error = url.searchParams.get("error");
                        
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
                                        <p>您可以关闭此页面，返回Obsidian继续使用。</p>
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
            });
            
            this.oauthServer.on("error", (err) => {
                reject(err);
            });
            
            this.oauthServer.listen(this.settings.serverPort, "localhost", () => {
                resolve();
            });
            
            this.oauthTimeout = setTimeout(() => {
                this.handleOAuthError("OAuth认证超时");
            }, 600000); // 10 minutes timeout
        });
    }

    cleanupOAuthServer() {
        if (this.oauthTimeout) {
            clearTimeout(this.oauthTimeout);
            this.oauthTimeout = null;
        }
        if (this.oauthServer) {
            this.oauthServer.close();
            this.oauthServer = null;
        }
        this.oauthInProgress = false;
    }

    async handleOAuthCallback(code: string) {
        try {
            var tokens = await this.exchangeCodeForToken(code);
            this.settings.accessToken = tokens.access_token;
            this.settings.refreshToken = tokens.refresh_token || this.settings.refreshToken;
            await this.plugin.saveSettings();
            new Notice("OAuth认证成功!");
            this.plugin.updateStatusBar("已连接");
            this.plugin.syncManager.setupAutoSync();
        } catch (t: any) {
            new Notice("认证失败: " + t.message);
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

    async exchangeCodeForToken(code: string): Promise<any> {
        return new Promise((resolve, reject) => {
            var data = querystring.stringify({
                grant_type: "authorization_code",
                client_id: this.settings.clientId,
                client_secret: this.settings.clientSecret,
                code: code,
                redirect_uri: this.getRedirectUri()
            });
            
            var options = {
                hostname: "dida365.com",
                port: 443,
                path: "/oauth/token",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(data)
                }
            };
            
            var req = https.request(options, (res) => {
                let body = "";
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () => {
                    if (res.statusCode === 200) {
                        try {
                            var parsed = JSON.parse(body);
                            resolve(parsed);
                        } catch (e: any) {
                            reject(new Error("解析token响应失败: " + e.message));
                        }
                    } else {
                        reject(new Error(`Token请求失败: ${res.statusCode} ` + body));
                    }
                });
            });
            
            req.on("error", (e) => {
                reject(new Error("Token请求网络错误: " + e.message));
            });
            
            req.write(data);
            req.end();
        });
    }

    async refreshAccessToken(): Promise<any> {
        if (!this.settings.refreshToken) throw new Error("没有refresh token");
        
        return new Promise((resolve, reject) => {
            var data = querystring.stringify({
                grant_type: "refresh_token",
                client_id: this.settings.clientId,
                client_secret: this.settings.clientSecret,
                refresh_token: this.settings.refreshToken
            });
            
            var options = {
                hostname: "dida365.com",
                port: 443,
                path: "/oauth/token",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(data)
                }
            };
            
            var req = https.request(options, (res) => {
                let body = "";
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", async () => {
                    if (res.statusCode === 200) {
                        try {
                            var parsed = JSON.parse(body);
                            this.settings.accessToken = parsed.access_token;
                            if (parsed.refresh_token) {
                                this.settings.refreshToken = parsed.refresh_token;
                            }
                            await this.plugin.saveSettings();
                            resolve(parsed);
                        } catch (e: any) {
                            reject(new Error("解析token响应失败: " + e.message));
                        }
                    } else {
                        reject(new Error("Token刷新失败"));
                    }
                });
            });
            
            req.on("error", (e) => {
                reject(new Error("Token刷新网络错误: " + e.message));
            });
            
            req.write(data);
            req.end();
        });
    }

    async makeAuthenticatedRequest(urlStr: string, options: any = {}): Promise<any> {
        if (!this.settings.accessToken) throw new Error("未认证，请先进行OAuth认证");
        
        return new Promise((resolve, reject) => {
            var url = new URL(urlStr);
            var isHttps = url.protocol === "https:";
            let client = isHttps ? https : http;
            
            let body = options.body || "";
            let method = options.method || "GET";
            
            var reqOptions: any = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: method,
                headers: {
                    Authorization: "Bearer " + this.settings.accessToken,
                    "Content-Type": "application/json",
                    "User-Agent": "Obsidian-DidaSync-Plugin/1.0",
                    ...options.headers
                }
            };
            
            if (body && method !== "GET") {
                reqOptions.headers["Content-Length"] = Buffer.byteLength(body);
            }
            
            var req = client.request(reqOptions, (res) => {
                let resBody = "";
                res.on("data", (chunk) => {
                    resBody += chunk;
                });
                res.on("end", async () => {
                    if (res.statusCode === 401) {
                        try {
                            await this.refreshAccessToken();
                            reqOptions.headers.Authorization = "Bearer " + this.settings.accessToken;
                            
                            // Retry request
                            var retryReq = client.request(reqOptions, (retryRes) => {
                                let retryBody = "";
                                retryRes.on("data", (chunk) => {
                                    retryBody += chunk;
                                });
                                retryRes.on("end", () => {
                                    resolve({
                                        ok: retryRes.statusCode! >= 200 && retryRes.statusCode! < 300,
                                        status: retryRes.statusCode,
                                        json: () => Promise.resolve(JSON.parse(retryBody)),
                                        text: () => Promise.resolve(retryBody)
                                    });
                                });
                            });
                            
                            retryReq.on("error", reject);
                            if (body && method !== "GET") retryReq.write(body);
                            retryReq.end();
                            
                        } catch (e) {
                            this.settings.accessToken = "";
                            this.settings.refreshToken = "";
                            await this.plugin.saveSettings();
                            this.plugin.updateStatusBar("未连接");
                            reject(new Error("认证已过期，请重新进行OAuth认证"));
                        }
                    } else {
                        resolve({
                            ok: res.statusCode! >= 200 && res.statusCode! < 300,
                            status: res.statusCode,
                            json: () => Promise.resolve(JSON.parse(resBody)),
                            text: () => Promise.resolve(resBody)
                        });
                    }
                });
            });
            
            req.on("error", (e) => {
                reject(new Error("网络请求错误: " + e.message));
            });
            
            if (body && method !== "GET") req.write(body);
            req.end();
        });
    }

    // --- Task API Wrappers ---

    async getProjects(): Promise<any[]> {
        const res = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/project");
        if (res.ok) return await res.json();
        throw new Error("Failed to fetch projects");
    }

    async getProjectTasks(projectId: string): Promise<any[]> {
        // Try multiple endpoints as in original code
        for (const url of [`https://api.dida365.com/open/v1/project/${projectId}/task`, `https://api.dida365.com/open/v1/project/${projectId}/data`, `https://api.dida365.com/open/v1/task?projectId=${projectId}`]) {
            try {
                const res = await this.makeAuthenticatedRequest(url);
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data)) return data;
                    if (data && data.tasks && Array.isArray(data.tasks)) return data.tasks;
                    if (data && data.data && Array.isArray(data.data)) return data.data;
                }
            } catch (e) {}
        }
        return [];
    }

    async getAllTasks(): Promise<any[]> {
        // Combined logic handled in SyncManager usually, but here we can expose raw fetches
        return [];
    }

    async createTask(taskData: any): Promise<any> {
        const res = await this.makeAuthenticatedRequest("https://api.dida365.com/open/v1/task", {
            method: "POST",
            body: JSON.stringify(taskData)
        });
        if (res.ok) return await res.json();
        throw await res.text();
    }

    async updateTask(taskId: string, taskData: any): Promise<any> {
        const res = await this.makeAuthenticatedRequest(`https://api.dida365.com/open/v1/task/${taskId}`, {
            method: "POST",
            body: JSON.stringify(taskData)
        });
        if (res.ok) return await res.json();
        throw await res.text();
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
}
