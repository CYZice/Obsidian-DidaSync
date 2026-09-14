import { App, Platform, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

const USER_GUIDE_URL_ZH = "https://github.com/CYZice/Obsidian-DidaSync/blob/main/docs/USER_GUIDE_ZH.md";
const USER_GUIDE_URL_EN = "https://github.com/CYZice/Obsidian-DidaSync/blob/main/docs/USER_GUIDE_EN.md";

export class GuideSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: this.t("settings.guide.title") });
        containerEl.createDiv({
            cls: "dida-settings-info dida-settings-info--primary",
            text: this.t("settings.guide.intro")
        });

        this.addGuideItem(containerEl, this.t("settings.guide.start.name"), this.t("settings.guide.start.desc"), this.t("settings.guide.goOauth"), () => this.plugin.settingTab.openTab("oauth"));
        this.addGuideItem(containerEl, this.t("settings.guide.markdown.name"), this.t("settings.guide.markdown.desc"), this.t("settings.guide.goSync"), () => this.plugin.settingTab.openTab("sync"));
        this.addGuideItem(containerEl, this.t("settings.guide.notesToDaily.name"), this.t("settings.guide.notesToDaily.desc"), this.t("settings.guide.goSync"), () => this.plugin.settingTab.openTab("sync"));
        this.addGuideItem(containerEl, this.t("settings.guide.didaNotes.name"), this.t("settings.guide.didaNotes.desc"), this.t("settings.guide.goSync"), () => this.plugin.settingTab.openTab("sync"));
        this.addGuideItem(containerEl, this.t("settings.guide.schedule.name"), this.t("settings.guide.schedule.desc"), this.t("settings.guide.goViews"), () => this.plugin.settingTab.openTab("ui"));
        this.addGuideItem(containerEl, this.t("settings.guide.ai.name"), this.t("settings.guide.ai.desc"), this.t("settings.guide.goMcp"), () => this.plugin.settingTab.openTab("mcp"), true);

        const guideUrl = this.plugin.getUiLanguage() === "zh" ? USER_GUIDE_URL_ZH : USER_GUIDE_URL_EN;
        const link = containerEl.createEl("a", { text: this.t("settings.guide.openFullGuide"), href: guideUrl, cls: "dida-settings-guide-link" });
        link.setAttr("target", "_blank");
        link.setAttr("rel", "noopener");
    }

    private addGuideItem(containerEl: HTMLElement, name: string, description: string, buttonText: string, onClick: () => void, desktopOnly = false): void {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desktopOnly && Platform.isMobile ? `${description}${this.t("settings.guide.mcpDesktopOnly")}` : description);
        if (!desktopOnly || !Platform.isMobile) {
            setting.addButton((button) => button.setButtonText(buttonText).onClick(onClick));
        }
    }
}
