import { App, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

export class AdvancedSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: this.t("settings.advanced.heading.maintenance") });

        const cleanInfo = containerEl.createDiv("dida-settings-info dida-settings-info--muted");
        cleanInfo.setText(this.t("settings.advanced.cleanInfo"));

        new Setting(containerEl)
            .setName(this.t("settings.advanced.autoClean.name"))
            .setDesc(this.t("settings.advanced.autoClean.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.autoCleanCompletedTasks)
                .onChange(async (value) => {
                    this.plugin.settings.autoCleanCompletedTasks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.advanced.cleanInterval.name"))
            .setDesc(this.t("settings.advanced.cleanInterval.desc"))
            .addDropdown((dropdown) => {
                for (let month = 1; month <= 12; month++) {
                    dropdown.addOption(month.toString(), this.t("settings.advanced.cleanInterval.months", { count: month }));
                }
                dropdown
                    .setValue(this.plugin.settings.autoCleanInterval.toString())
                    .onChange(async (value) => {
                        this.plugin.settings.autoCleanInterval = parseInt(value, 10);
                        await this.plugin.saveSettings();
                    });
            });

        containerEl.createEl("h3", { text: this.t("settings.advanced.heading.reset") });

        const resetInfo = containerEl.createDiv("dida-settings-info dida-settings-info--warning");
        resetInfo.setText(this.t("settings.advanced.resetInfo"));

        new Setting(containerEl)
            .setName(this.t("settings.advanced.reset.name"))
            .setDesc(this.t("settings.advanced.reset.desc"))
            .addButton((button) => button
                .setButtonText(this.t("settings.advanced.reset.button"))
                .setWarning()
                .onClick(async () => {
                    if (!this.plugin.settings.accessToken) {
                        new Notice(this.t("error.oauthRequired"));
                        return;
                    }

                    if (confirm(this.t("settings.advanced.reset.confirm"))) {
                        this.plugin.settings.tasks = [];
                        await this.plugin.saveSettings();
                        await this.plugin.syncManager.syncFromDidaList();
                    }
                }));
    }
}
