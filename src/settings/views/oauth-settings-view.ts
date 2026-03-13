import { App, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";
import { debounce } from "../../utils";

export class OAuthSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        const oauthContainer = containerEl.createDiv();
        oauthContainer.createEl("h3", { text: "OAuth配置" });

        const step1Div = oauthContainer.createDiv();
        step1Div.style.cssText = "margin: 10px 0;";
        step1Div.createEl("p", { text: "第1步：请复制下面的链接到浏览器→进入到滴答清单开发者后台（需要登入你的滴答清单账号）→Manage Apps创建应用→自动获取Client ID和Client Secret→填入到下面的设置窗口" });

        const linkDiv = step1Div.createDiv();
        linkDiv.style.cssText = "display: flex; align-items: center; gap: 10px; background: transparent; padding: 8px; border-radius: 5px;";
        linkDiv.createEl("code", { text: "https://developer.dida365.com/manage" });
        linkDiv.createEl("button", { text: "复制", cls: "mod-small" }).onclick = () => {
            navigator.clipboard.writeText("https://developer.dida365.com/manage");
            new Notice("开发者后台链接已复制到剪贴板");
        };

        const step2Div = oauthContainer.createDiv();
        step2Div.style.cssText = "margin: 10px 0;";
        step2Div.createEl("p", { text: "第2步：请将下面的URI复制粘贴到滴答清单开发者后台的OAuth redirect URL→Save保存→点击OAuth认证按钮" });

        const redirectDiv = step2Div.createDiv();
        redirectDiv.style.cssText = "background: transparent; padding: 10px; border-radius: 5px; margin: 10px 0;";
        redirectDiv.createEl("strong", { text: "重定向URI配置：" });
        redirectDiv.createEl("br");

        const uriDiv = redirectDiv.createDiv();
        uriDiv.style.cssText = "display: flex; align-items: center; gap: 10px; margin: 5px 0;";
        uriDiv.createEl("code", { text: `http://localhost:${this.plugin.settings.serverPort}/callback` });
        uriDiv.createEl("button", { text: "复制", cls: "mod-small" }).onclick = () => {
            navigator.clipboard.writeText(`http://localhost:${this.plugin.settings.serverPort}/callback`);
            new Notice("重定向URI已复制到剪贴板");
        };

        new Setting(containerEl).setName("Client ID").setDesc("滴答清单应用的Client ID").addText(t => t.setPlaceholder("输入Client ID").setValue(this.plugin.settings.clientId).onChange(async t => {
            this.plugin.settings.clientId = t;
            await this.plugin.saveSettings();
        }));

        new Setting(containerEl).setName("Client Secret").setDesc("滴答清单应用的Client Secret").addText(t => t.setPlaceholder("输入Client Secret").setValue(this.plugin.settings.clientSecret).onChange(async t => {
            this.plugin.settings.clientSecret = t;
            await this.plugin.saveSettings();
        }));

        new Setting(containerEl).setName("服务器端口").setDesc("OAuth回调服务器端口（修改后需要更新重定向URI配置）").addText(t => {
            const debouncedSave = debounce(async (val: string) => {
                const port = parseInt(val) || 8080;
                this.plugin.settings.serverPort = port;
                await this.plugin.saveSettings();
                this.updateRedirectUriDisplay(containerEl, port);
            }, 300);
            t.setPlaceholder("8080").setValue(this.plugin.settings.serverPort.toString()).onChange(debouncedSave);
        });

        new Setting(containerEl).setName("OAuth认证").setDesc("点击开始OAuth认证流程").addButton(t => t.setButtonText("开始认证").onClick(() => {
            this.plugin.apiClient.startOAuthFlow();
        }));

        const statusDiv = containerEl.createDiv();
        statusDiv.style.cssText = "margin: 10px 0; padding: 10px; border-radius: 5px;";
        if (this.plugin.settings.accessToken) {
            statusDiv.style.color = "#06dc38ff";
            statusDiv.textContent = "✓ 已认证";
        } else {
            statusDiv.style.backgroundColor = "#f8d7da";
            statusDiv.style.color = "#c30014ff";
            statusDiv.textContent = "✗ 未认证";
        }
    }

    private updateRedirectUriDisplay(containerEl: HTMLElement, port: number) {
        containerEl.querySelectorAll("code").forEach(e => {
            if (e.textContent && e.textContent.includes("/callback")) {
                e.textContent = `http://localhost:${port}/callback`;
            }
        });
        containerEl.querySelectorAll("button").forEach(btn => {
            if (btn.textContent === "复制") {
                const parent = btn.closest("div");
                if (parent && parent.querySelector("code")?.textContent?.includes("/callback")) {
                    btn.onclick = () => {
                        navigator.clipboard.writeText(`http://localhost:${port}/callback`);
                        new Notice("重定向URI已复制到剪贴板");
                    };
                }
            }
        });
    }
}
