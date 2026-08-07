import { App, Platform, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

const USER_GUIDE_URL = "https://github.com/CYZice/Obsidian-DidaSync/blob/main/docs/USER_GUIDE_ZH.md";

export class GuideSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "DidaSync 使用指南" });
        containerEl.createDiv({
            cls: "dida-settings-info dida-settings-info--primary",
            text: "DidaSync 将滴答清单 / TickTick 的行动系统与 Obsidian 的笔记系统连接起来。先从“同步任务”开始，再按自己的工作方式开启笔记、规划或 AI 功能。"
        });

        this.addGuideItem(containerEl, "开始同步任务", "适合第一次使用。完成 OAuth 授权后，打开侧边栏或运行“手动双向同步”，即可在 Obsidian 中查看和编辑滴答任务。", "前往 OAuth 设置", () => this.plugin.settingTab.openTab("oauth"));
        this.addGuideItem(containerEl, "在 Markdown 中管理待办", "开启原生任务同步后，在笔记中输入 - [ ] 会出现操作菜单；关联后勾选任务可同步更新远端状态。", "前往同步设置", () => this.plugin.settingTab.openTab("sync"));
        this.addGuideItem(containerEl, "把任务写入日记、周记或复盘", "“任务写入笔记”会按日、周、月、年或自定义范围生成任务汇总；它不同于“滴答笔记同步”。", "前往同步设置", () => this.plugin.settingTab.openTab("sync"));
        this.addGuideItem(containerEl, "同步滴答笔记到 Obsidian", "将所选清单中的滴答 NOTE 一条一文件同步到 Vault，可从侧边栏的笔记入口或命令面板执行。", "前往同步设置", () => this.plugin.settingTab.openTab("sync"));
        this.addGuideItem(containerEl, "安排与专注", "在任务侧边栏切换时间块视图安排日程；桌面端还可打开时间线日历和番茄钟。", "前往视图设置", () => this.plugin.settingTab.openTab("ui"));
        this.addGuideItem(containerEl, "让 AI 协助管理任务", "桌面端可启用本地 MCP 服务。建议先使用只读模式；关闭只读后，兼容 MCP 的 AI 工具才能创建、修改或完成任务。", "前往 MCP 设置", () => this.plugin.settingTab.openTab("mcp"), true);

        const link = containerEl.createEl("a", { text: "打开完整使用指南（GitHub）", href: USER_GUIDE_URL, cls: "dida-settings-guide-link" });
        link.setAttr("target", "_blank");
        link.setAttr("rel", "noopener");
    }

    private addGuideItem(containerEl: HTMLElement, name: string, description: string, buttonText: string, onClick: () => void, desktopOnly = false): void {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desktopOnly && Platform.isMobile ? `${description}（MCP 仅桌面端可用）` : description);
        if (!desktopOnly || !Platform.isMobile) {
            setting.addButton((button) => button.setButtonText(buttonText).onClick(onClick));
        }
    }
}
