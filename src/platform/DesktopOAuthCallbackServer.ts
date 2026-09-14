import * as http from "http";
import { translateDefault, Translator } from "../i18n";

export interface DesktopOAuthCallbackServerHandle {
    close(): Promise<void>;
}

interface ListenTarget {
    host: string;
    ipv6Only: boolean;
}

interface StartOptions {
    port: number;
    callbackBaseUrl: string;
    listenTargets: ListenTarget[];
    onCode: (code: string) => void;
    onError: (error: string) => void;
    translate?: Translator;
}

export async function startDesktopOAuthCallbackServer(options: StartOptions): Promise<DesktopOAuthCallbackServerHandle> {
    const t = options.translate || translateDefault;
    const servers: http.Server[] = [];
    const close = async () => {
        const activeServers = servers.splice(0);
        await Promise.all(activeServers.map(server => new Promise<void>(resolve => {
            try {
                server.close(() => resolve());
            } catch (_error) {
                resolve();
            }
        })));
    };

    await new Promise<void>((resolve, reject) => {
        let pending = options.listenTargets.length;
        let settled = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            void close();
            reject(error);
        };

        for (const target of options.listenTargets) {
            const server = http.createServer((request, response) => {
                try {
                    const url = new URL(request.url || "", options.callbackBaseUrl);
                    if (url.pathname !== "/callback") {
                        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                        response.end("Not Found");
                        return;
                    }
                    const code = url.searchParams.get("code");
                    const error = url.searchParams.get("error");
                    if (error) {
                        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                        response.end(`<h1>${t("oauthServer.failHeading")}</h1><p>${t("oauthServer.retryHint")}</p>`);
                        options.onError(error);
                    } else if (code) {
                        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                        response.end(`<h1>${t("oauthServer.successHeading")}</h1><p>${t("oauthServer.successHint")}</p>`);
                        options.onCode(code);
                    } else {
                        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                        response.end(`<h1>${t("oauthServer.failHeading")}</h1><p>${t("oauthServer.missingCodeHint")}</p>`);
                        options.onError(t("error.noAuthCode"));
                    }
                } catch (_error) {
                    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                    response.end("Invalid OAuth callback");
                }
            });
            servers.push(server);
            server.once("error", (error: Error) => {
                const hostLabel = target.host.includes(":") ? `[${target.host}]` : target.host;
                fail(new Error(t("error.callbackServerStartSimple", { host: hostLabel, port: options.port, message: error.message })));
            });
            server.listen({ port: options.port, host: target.host, ipv6Only: target.ipv6Only }, () => {
                pending -= 1;
                if (!settled && pending === 0) {
                    settled = true;
                    resolve();
                }
            });
        }
    });

    return { close };
}
