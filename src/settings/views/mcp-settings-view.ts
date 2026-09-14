import { App, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

export class McpSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: this.t("settings.mcp.heading") });

        const mcpInfo = containerEl.createDiv("dida-settings-info dida-settings-info--muted");
        mcpInfo.setText(this.t("settings.mcp.info"));

        const endpoint = () => `http://127.0.0.1:${this.plugin.settings.mcpPort || 35829}/mcp`;
        const configText = () => JSON.stringify({
            transport: "http",
            url: endpoint(),
            headers: {
                Authorization: `Bearer ${this.plugin.settings.mcpToken || "<DIDASYNC_MCP_TOKEN>"}`
            }
        }, null, 2);

        const restartMcpServer = async () => {
            try {
                await this.plugin.mcpServerManager.restart();
                new Notice(this.plugin.settings.enableMcpServer ? this.t("settings.mcp.serverUpdated") : this.t("settings.mcp.serverStopped"));
            } catch (error: any) {
                this.plugin.mcpServerManager.notifyStartupError(error);
            }
        };

        new Setting(containerEl)
            .setName(this.t("settings.mcp.enable.name"))
            .setDesc(this.t("settings.mcp.enable.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableMcpServer)
                .onChange(async (value) => {
                    this.plugin.settings.enableMcpServer = value;
                    if (value && !this.plugin.settings.mcpToken) {
                        this.plugin.settings.mcpToken = this.plugin.mcpServerManager.generateToken();
                    }
                    await this.plugin.saveSettings();
                    await restartMcpServer();
                    containerEl.empty();
                    this.render(containerEl);
                }));

        new Setting(containerEl)
            .setName(this.t("settings.mcp.port.name"))
            .setDesc(this.t("settings.mcp.port.desc"))
            .addText((text) => text
                .setPlaceholder("35829")
                .setValue((this.plugin.settings.mcpPort || 35829).toString())
                .onChange(async (value) => {
                    this.plugin.settings.mcpPort = parseInt(value, 10) || 35829;
                    await this.plugin.saveSettings();
                    if (this.plugin.settings.enableMcpServer) {
                        await restartMcpServer();
                    }
                }));

        new Setting(containerEl)
            .setName(this.t("settings.mcp.readOnly.name"))
            .setDesc(this.t("settings.mcp.readOnly.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.mcpReadOnly)
                .onChange(async (value) => {
                    this.plugin.settings.mcpReadOnly = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.mcp.timeZone.name"))
            .setDesc(this.t("settings.mcp.timeZone.desc"))
            .addText((text) => text
                .setPlaceholder(this.plugin.detectSystemTimeZone())
                .setValue(this.plugin.getUserTimeZone())
                .onChange(async (value) => {
                    const next = value.trim();
                    if (!this.plugin.isValidTimeZone(next)) {
                        new Notice(this.t("settings.mcp.timeZone.invalid", { value: next || this.t("settings.mcp.timeZone.empty") }));
                        return;
                    }
                    this.plugin.settings.userTimeZone = next;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.mcp.token.name"))
            .setDesc(this.plugin.settings.mcpToken ? this.t("settings.mcp.token.descReady") : this.t("settings.mcp.token.descGenerated"))
            .addButton((button) => button
                .setButtonText(this.t("settings.mcp.token.regenerate"))
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.mcpToken = this.plugin.mcpServerManager.generateToken();
                    await this.plugin.saveSettings();
                    new Notice(this.t("settings.mcp.token.regenerated"));
                    containerEl.empty();
                    this.render(containerEl);
                }));

        if (this.plugin.settings.mcpToken) {
            const tokenPre = containerEl.createEl("pre", { cls: "dida-settings-pre" });
            tokenPre.setText(this.plugin.settings.mcpToken);
        }

        new Setting(containerEl)
            .setName(this.t("settings.mcp.skillPath.name"))
            .setDesc(this.t("settings.mcp.skillPath.desc"))
            .addText((text) => text
                .setPlaceholder("dida/SKILL.md")
                .setValue(this.plugin.settings.mcpSkillNotePath || "dida/SKILL.md")
                .onChange(async (value) => {
                    this.plugin.settings.mcpSkillNotePath = value.trim() || "dida/SKILL.md";
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.mcp.export.name"))
            .setDesc(this.t("settings.mcp.export.desc"))
            .addButton((button) => button
                .setButtonText(this.t("settings.mcp.export.button"))
                .setCta()
                .onClick(async () => {
                    try {
                        const path = await this.plugin.exportMcpSkillDocument();
                        new Notice(this.t("settings.mcp.export.done", { path }));
                    } catch (error: any) {
                        new Notice(this.t("settings.mcp.export.failed", { message: error?.message || error }));
                    }
                }));

        const configDiv = containerEl.createDiv("dida-settings-config");
        configDiv.createEl("strong", { text: this.t("settings.mcp.configLabel") });
        const configInput = configDiv.createEl("textarea", { cls: "dida-settings-config-input" });
        configInput.readOnly = true;
        configInput.value = configText();
        configInput.onclick = () => configInput.select();
    }
}
