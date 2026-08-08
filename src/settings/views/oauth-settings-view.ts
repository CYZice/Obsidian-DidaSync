import { App, Notice, Platform, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { DidaServiceRegion, OAuthCallbackMode } from "../../types";
import { debounce } from "../../utils";
import { AbstractSettingsView } from "./abstract-settings-view";

export class OAuthSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        const oauthContainer = containerEl.createDiv();
        oauthContainer.createEl("h3", { text: "OAuth 配置" });
        const serviceConfig = this.plugin.apiClient.getServiceConfig();

        new Setting(oauthContainer)
            .setName("服务区域")
            .setDesc("切换后需使用该区域开发者后台创建的应用重新认证。")
            .addDropdown((dropdown) => dropdown
                .addOption("dida365", "滴答清单（中国区）")
                .addOption("ticktick", "TickTick（国际版）")
                .setValue(this.plugin.apiClient.getServiceRegion())
                .onChange(async (value: DidaServiceRegion) => {
                    const region = value === "ticktick" ? "ticktick" : "dida365";
                    if (region === this.plugin.apiClient.getServiceRegion()) return;
                    this.plugin.apiClient.cleanupOAuthServer();
                    this.plugin.settings.serviceRegion = region;
                    this.plugin.settings.accessToken = "";
                    this.plugin.settings.refreshToken = "";
                    await this.plugin.saveSettings();
                    new Notice(`已切换至 ${this.plugin.apiClient.getServiceConfig().label}，请重新认证。`);
                    containerEl.empty();
                    this.render(containerEl);
                }));

        const step1Div = oauthContainer.createDiv("dida-settings-block");
        step1Div.createEl("p", {
            text: `第 1 步：复制下面的链接到浏览器，进入${serviceConfig.label}开发者后台，创建应用并获取 Client ID 和 Client Secret。`
        });

        const linkDiv = step1Div.createDiv("dida-settings-inline-row dida-settings-link-box");
        const manageInput = linkDiv.createEl("input", {
            type: "text",
            value: serviceConfig.developerUrl
        });
        manageInput.readOnly = true;
        manageInput.addClass("dida-settings-readonly-input");
        manageInput.onclick = () => manageInput.select();

        const step2Div = oauthContainer.createDiv("dida-settings-block");
        step2Div.createEl("p", {
            text: Platform.isMobile
                ? "第 2 步：先设置回调地址和端口，再将下面的重定向 URI 复制到滴答清单开发者后台的 OAuth redirect URL。保存后使用下方按钮打开认证链接，授权完成后请从地址栏复制 code 参数。"
                : "第 2 步：先设置回调地址和端口，再将下面的 URI 复制到滴答清单开发者后台的 OAuth redirect URL，保存后点击 OAuth 认证按钮。"
        });

        new Setting(step2Div)
            .setName("回调地址")
            .setDesc("修改后请同步更新开发者后台的 redirect URL。")
            .addDropdown((dropdown) => dropdown
                .addOption("localhost", "localhost")
                .addOption("ipv4", "127.0.0.1")
                .setValue(this.getCallbackMode())
                .onChange(async (value: OAuthCallbackMode) => {
                    this.plugin.settings.oauthCallbackMode = value === "ipv4" ? "ipv4" : "localhost";
                    await this.plugin.saveSettings();
                    this.updateRedirectUriDisplay(step2Div);
                    new Notice("OAuth 回调地址已切换，请将开发者后台 redirect URL 更新为当前显示的地址。");
                }));

        new Setting(step2Div)
            .setName("服务器端口")
            .setDesc("修改后请同步更新开发者后台的 redirect URL。")
            .addText((text) => {
                const debouncedSave = debounce(async (value: string) => {
                    const port = parseInt(value, 10) || 8080;
                    this.plugin.settings.serverPort = port;
                    await this.plugin.saveSettings();
                    this.updateRedirectUriDisplay(step2Div);
                }, 300);

                text
                    .setPlaceholder("8080")
                    .setValue(this.plugin.settings.serverPort.toString())
                    .onChange(debouncedSave);
            });

        const redirectDiv = step2Div.createDiv("dida-settings-code-box");
        redirectDiv.createEl("strong", { text: "重定向 URI：" });
        redirectDiv.createEl("br");

        const uriDiv = redirectDiv.createDiv("dida-settings-inline-row dida-settings-inline-margin");
        const redirectInput = uriDiv.createEl("input", {
            type: "text",
            value: this.plugin.apiClient.getRedirectUri()
        });
        redirectInput.readOnly = true;
        redirectInput.addClass("dida-settings-readonly-input");
        redirectInput.onclick = () => redirectInput.select();

        if (!Platform.isMobile) {
            step2Div.createEl("p", {
                text: "如果开发者后台已登记旧地址，可继续使用 localhost；如果 Windows 上授权后回调页空白或长时间无响应，可切换为 127.0.0.1。"
            });
        } else {
            step2Div.createEl("p", {
                text: "移动端仅支持手动认证流程。你现在也可以修改回调地址和端口；如果浏览器打开本地回调页失败，这是正常现象，请直接从地址栏复制 code 参数并粘贴回来。"
            });
        }

        new Setting(containerEl)
            .setName("Client ID")
            .setDesc("滴答清单应用的 Client ID")
            .addText((text) => text
                .setPlaceholder("输入 Client ID")
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Client Secret")
            .setDesc("滴答清单应用的 Client Secret")
            .addText((text) => text
                .setPlaceholder("输入 Client Secret")
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(Platform.isMobile ? "认证链接" : "OAuth 认证")
            .setDesc(Platform.isMobile ? "打开授权页面并获取授权码。" : "点击开始 OAuth 认证流程。")
            .addButton((button) => button
                .setButtonText(Platform.isMobile ? "打开认证链接" : "开始认证")
                .onClick(() => {
                    if (Platform.isMobile) {
                        this.plugin.apiClient.startManualOAuthFlow();
                        return;
                    }
                    this.plugin.apiClient.startOAuthFlow();
                }));

        if (Platform.isMobile) {
            let manualCode = "";
            new Setting(containerEl)
                .setName("授权码")
                .setDesc("将授权后得到的 code 粘贴到这里完成认证。")
                .addText((text) => text
                    .setPlaceholder("粘贴 OAuth code")
                    .onChange((value) => {
                        manualCode = value.trim();
                    }))
                .addButton((button) => button
                    .setButtonText("提交授权码")
                    .onClick(async () => {
                        if (!manualCode) {
                            new Notice("请先输入授权码");
                            return;
                        }
                        await this.plugin.apiClient.handleOAuthCallback(manualCode, this.plugin.apiClient.getRedirectUri());
                        containerEl.empty();
                        this.render(containerEl);
                    }));
        }

        const statusDiv = containerEl.createDiv("dida-settings-status");
        if (this.plugin.settings.accessToken) {
            statusDiv.addClass("dida-settings-status--success");
            statusDiv.textContent = "已认证";
        } else {
            statusDiv.addClass("dida-settings-status--error");
            statusDiv.textContent = "未认证";
        }
    }

    private getCallbackMode(): OAuthCallbackMode {
        return this.plugin.settings.oauthCallbackMode === "ipv4" ? "ipv4" : "localhost";
    }

    private updateRedirectUriDisplay(containerEl: HTMLElement) {
        containerEl.querySelectorAll('input[readonly]').forEach((element) => {
            const input = element as HTMLInputElement;
            if (input.value && input.value.includes("/callback")) {
                input.value = this.plugin.apiClient.getLocalRedirectUri();
            }
        });
    }
}
