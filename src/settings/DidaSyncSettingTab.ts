import { App, Platform, PluginSettingTab } from "obsidian";
import DidaSyncPlugin from "../main";
import { AbstractSettingsView } from "./views/abstract-settings-view";
import { OAuthSettingsView } from "./views/oauth-settings-view";
import { SyncSettingsView } from "./views/sync-settings-view";
import { UISettingsView } from "./views/ui-settings-view";
import { AdvancedSettingsView } from "./views/advanced-settings-view";
import { GuideSettingsView } from "./views/guide-settings-view";

class LazyMcpSettingsView extends AbstractSettingsView {
    render(containerEl: HTMLElement): void {
        containerEl.createDiv({ text: "正在加载 MCP 设置…", cls: "dida-settings-info" });
        void import("./views/mcp-settings-view").then(({ McpSettingsView }) => {
            containerEl.empty();
            new McpSettingsView(this.app, this.plugin).render(containerEl);
        });
    }
}

export class DidaSyncSettingTab extends PluginSettingTab {
    plugin: DidaSyncPlugin;
    private activeTab = "oauth";

    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("dida-settings-container");

        // 左侧 Tab 菜单
        const tabsContainer = containerEl.createDiv({ cls: "dida-settings-tabs" });
        
        // 右侧内容区域
        const contentContainer = containerEl.createDiv({ cls: "dida-settings-content" });

        const tabs = [
            { id: "oauth", name: "OAuth", view: new OAuthSettingsView(this.app, this.plugin) },
            { id: "sync", name: "同步", view: new SyncSettingsView(this.app, this.plugin) },
            { id: "ui", name: "视图", view: new UISettingsView(this.app, this.plugin) },
            { id: "guide", name: "指南", view: new GuideSettingsView(this.app, this.plugin) },
            ...(Platform.isMobile ? [] : [{ id: "mcp", name: "MCP", view: new LazyMcpSettingsView(this.app, this.plugin) }]),
            { id: "advanced", name: "高级", view: new AdvancedSettingsView(this.app, this.plugin) }
        ];
        if (!tabs.some(tab => tab.id === this.activeTab)) {
            this.activeTab = "oauth";
        }

        tabs.forEach(tab => {
            const tabEl = tabsContainer.createDiv({ cls: "dida-settings-tab-item" });
            if (this.activeTab === tab.id) {
                tabEl.addClass("active");
            }
            
            tabEl.setText(tab.name);
            
            tabEl.onclick = () => {
                this.activeTab = tab.id;
                // 更新选中状态
                tabsContainer.querySelectorAll(".dida-settings-tab-item").forEach(el => el.removeClass("active"));
                tabEl.addClass("active");
                // 重新渲染内容
                this.renderContent(contentContainer, tab.view);
            };
        });

        // 初始渲染
        const activeView = tabs.find(t => t.id === this.activeTab)?.view;
        if (activeView) {
            this.renderContent(contentContainer, activeView);
        }
    }

    private renderContent(container: HTMLElement, view: AbstractSettingsView) {
        container.empty();
        view.render(container);
    }

    openTab(tabId: string) {
        this.activeTab = tabId;
        this.display();
    }
}
