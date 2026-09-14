import { App, Notice, Platform, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { DidaServiceRegion, OAuthCallbackMode } from "../../types";
import { debounce } from "../../utils";
import { AbstractSettingsView } from "./abstract-settings-view";

export class OAuthSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    private getServiceRegionLabel(region: DidaServiceRegion): string {
        return region === "ticktick"
            ? this.t("settings.oauth.region.ticktick")
            : this.t("settings.oauth.region.dida365");
    }

    render(containerEl: HTMLElement): void {
        const oauthContainer = containerEl.createDiv();
        oauthContainer.createEl("h3", { text: this.t("settings.oauth.heading") });
        const serviceConfig = this.plugin.apiClient.getServiceConfig();

        new Setting(oauthContainer)
            .setName(this.t("settings.oauth.region.name"))
            .setDesc(this.t("settings.oauth.region.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("dida365", this.getServiceRegionLabel("dida365"))
                .addOption("ticktick", this.getServiceRegionLabel("ticktick"))
                .setValue(this.plugin.apiClient.getServiceRegion())
                .onChange(async (value: DidaServiceRegion) => {
                    const region = value === "ticktick" ? "ticktick" : "dida365";
                    if (region === this.plugin.apiClient.getServiceRegion()) return;
                    this.plugin.apiClient.cleanupOAuthServer();
                    this.plugin.settings.serviceRegion = region;
                    this.plugin.settings.accessToken = "";
                    this.plugin.settings.refreshToken = "";
                    await this.plugin.saveSettings();
                    new Notice(this.t("settings.oauth.region.switched", { region: this.getServiceRegionLabel(region) }));
                    containerEl.empty();
                    this.render(containerEl);
                }));

        const step1Div = oauthContainer.createDiv("dida-settings-block");
        step1Div.createEl("p", {
            text: this.t("settings.oauth.step1")
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
                ? this.t("settings.oauth.step2.mobile")
                : this.t("settings.oauth.step2.desktop")
        });

        new Setting(step2Div)
            .setName(this.t("settings.oauth.callback.name"))
            .setDesc(this.t("settings.oauth.callback.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("localhost", "localhost")
                .addOption("ipv4", "127.0.0.1")
                .setValue(this.getCallbackMode())
                .onChange(async (value: OAuthCallbackMode) => {
                    this.plugin.settings.oauthCallbackMode = value === "ipv4" ? "ipv4" : "localhost";
                    await this.plugin.saveSettings();
                    this.updateRedirectUriDisplay(step2Div);
                    new Notice(this.t("settings.oauth.callback.switched"));
                }));

        new Setting(step2Div)
            .setName(this.t("settings.oauth.port.name"))
            .setDesc(this.t("settings.oauth.callback.desc"))
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
        redirectDiv.createEl("strong", { text: this.t("settings.oauth.redirectUri") });
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
                text: this.t("settings.oauth.callbackNote.desktop")
            });
        } else {
            step2Div.createEl("p", {
                text: this.t("settings.oauth.callbackNote.mobile")
            });
        }

        new Setting(containerEl)
            .setName(this.t("settings.oauth.clientId.name"))
            .setDesc(this.t("settings.oauth.clientId.desc"))
            .addText((text) => text
                .setPlaceholder(this.t("settings.oauth.clientId.placeholder"))
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.oauth.clientSecret.name"))
            .setDesc(this.t("settings.oauth.clientSecret.desc"))
            .addText((text) => text
                .setPlaceholder(this.t("settings.oauth.clientSecret.placeholder"))
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(Platform.isMobile ? this.t("settings.oauth.link.name") : this.t("settings.oauth.auth.name"))
            .setDesc(Platform.isMobile ? this.t("settings.oauth.link.desc") : this.t("settings.oauth.auth.desc"))
            .addButton((button) => button
                .setButtonText(Platform.isMobile ? this.t("settings.oauth.link.button") : this.t("settings.oauth.auth.button"))
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
                .setName(this.t("settings.oauth.code.name"))
                .setDesc(this.t("settings.oauth.code.desc"))
                .addText((text) => text
                    .setPlaceholder(this.t("settings.oauth.code.placeholder"))
                    .onChange((value) => {
                        manualCode = value.trim();
                    }))
                .addButton((button) => button
                    .setButtonText(this.t("settings.oauth.code.submit"))
                    .onClick(async () => {
                        if (!manualCode) {
                            new Notice(this.t("settings.oauth.code.empty"));
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
            statusDiv.textContent = this.t("settings.oauth.status.authorized");
        } else {
            statusDiv.addClass("dida-settings-status--error");
            statusDiv.textContent = this.t("settings.oauth.status.unauthorized");
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
