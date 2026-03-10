import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import DidaSyncPlugin from "../main";
import { debounce } from "../utils";

export class DidaSyncSettingTab extends PluginSettingTab {
    plugin: DidaSyncPlugin;

    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "滴答清单同步设置" });

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
                this.updateRedirectUriDisplay(port);
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

        containerEl.createEl("h3", { text: "同步设置" });
        new Setting(containerEl).setName("自动同步").setDesc("启用后会定期从滴答清单同步任务").addToggle(t => t.setValue(this.plugin.settings.autoSync).onChange(async t => {
            this.plugin.settings.autoSync = t;
            await this.plugin.saveSettings();
            this.plugin.syncManager.setupAutoSync();
        }));

        new Setting(containerEl).setName("显示归档项目").setDesc("选择是否在任务清单中显示已归档的项目").addDropdown(t => t.addOption("false", "隐藏归档项目").addOption("true", "显示归档项目").setValue(this.plugin.settings.showArchivedProjects.toString()).onChange(async t => {
            this.plugin.settings.showArchivedProjects = "true" === t;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));

        new Setting(containerEl).setName("同步间隔").setDesc("自动从滴答清单同步的间隔时间（分钟）").addSlider(t => t.setLimits(5, 120, 5).setValue(this.plugin.settings.syncInterval).setDynamicTooltip().onChange(async t => {
            this.plugin.settings.syncInterval = t;
            await this.plugin.saveSettings();
            this.plugin.syncManager.setupAutoSync();
        }));

        new Setting(containerEl).setName("手动同步").setDesc("立即执行双向同步").addButton(t => t.setButtonText("开始同步").onClick(async () => {
            await this.plugin.manualSync();
        }));

        containerEl.createEl("h3", { text: "主任务视图设置" });
        new Setting(containerEl).setName("默认视图模式").setDesc("右侧边栏打开任务清单时默认显示的视图类型").addDropdown(t => t.addOption("task", "任务列表").addOption("timeblock", "时间段视图").setValue(this.plugin.settings.defaultViewMode || "task").onChange(async t => {
            this.plugin.settings.defaultViewMode = t as any;
            await this.plugin.saveSettings();
        }));

        new Setting(containerEl).setName("时间块每小时高度").setDesc("时间段视图中每小时的高度（像素），调整后需要切换视图才能生效").addSlider(t => t.setLimits(50, 100, 5).setValue(this.plugin.settings.timeBlockHourHeight || 80).setDynamicTooltip().onChange(async t => {
            this.plugin.settings.timeBlockHourHeight = t;
            await this.plugin.saveSettings();
            document.documentElement.style.setProperty("--dida-hour-height", t + "px");
        }));

        new Setting(containerEl).setName("时间段视图起始时间").setDesc("自定义设置时间段视图的起始时间（保持24小时刻度）").addDropdown(e => {
            for (let t = 0; t < 24; t++) {
                var i = t.toString().padStart(2, "0") + ":00";
                e.addOption(t.toString(), i);
            }
            e.setValue((this.plugin.settings.timeBlockStartHour || 0).toString()).onChange(async t => {
                this.plugin.settings.timeBlockStartHour = parseInt(t);
                await this.plugin.saveSettings();
                this.plugin.refreshTaskView();
            });
        });

        containerEl.createEl("h3", { text: "自动清理设置" });
        const cleanInfo = containerEl.createDiv();
        cleanInfo.style.cssText = "padding: 10px; border-radius: 5px; margin: 10px 0; color: #6c757d;";
        cleanInfo.innerHTML = "<strong>说明：</strong>启用自动清理功能后，插件会在每次启动时（延迟30秒）自动清理指定时间之前的已完成任务数据，以保持数据文件的整洁。此操作仅清理本地数据，不会影响滴答清单云端数据。";

        new Setting(containerEl).setName("自动清理已完成任务").setDesc("启用后会在插件启动时自动清理指定时间之前的已完成任务数据").addToggle(t => t.setValue(this.plugin.settings.autoCleanCompletedTasks).onChange(async t => {
            this.plugin.settings.autoCleanCompletedTasks = t;
            await this.plugin.saveSettings();
        }));

        new Setting(containerEl).setName("清理间隔").setDesc("自动清理已完成任务的时间间隔（月数）").addDropdown(e => {
            for (let t = 1; t <= 12; t++) e.addOption(t.toString(), t + "个月");
            e.setValue(this.plugin.settings.autoCleanInterval.toString()).onChange(async t => {
                this.plugin.settings.autoCleanInterval = parseInt(t);
                await this.plugin.saveSettings();
            });
        });

        containerEl.createEl("h3", { text: "原生任务同步设置" });
        const nativeInfo = containerEl.createDiv();
        nativeInfo.style.cssText = "padding: 10px; border-radius: 5px; margin: 10px 0; color: #0066cc;";
        nativeInfo.innerHTML = '<strong>说明：</strong>原生任务同步功能支持手动同步Obsidian中的原生任务格式（- [ ] ）到滴答清单。启用后，输入"- [ ] "时会弹出操作菜单，可选择同步到滴答清单或添加到期日期。同步后会在任务后添加链接，方便跳转到滴答清单查看详情。';

        new Setting(containerEl).setName("启用原生任务同步").setDesc('启用后可以手动同步Obsidian原生任务格式到滴答清单，输入"- [ ] "时显示操作菜单').addToggle(t => t.setValue(this.plugin.settings.enableNativeTaskSync).onChange(async t => {
            this.plugin.settings.enableNativeTaskSync = t;
            await this.plugin.saveSettings();
        }));

        containerEl.createEl("h3", { text: "数据重置" });
        const resetInfo = containerEl.createDiv();
        resetInfo.style.cssText = "padding: 10px; border-radius: 5px; margin: 10px 0; color: #856404; border: 1px solid #ffeaa7;";
        resetInfo.innerHTML = "<strong>⚠️ 警告：</strong>此操作将完全清空本地任务数据，并从滴答清单云端重新获取最新数据。此操作不可逆，建议备份仓库后使用。(适用于Obsidian本地任务数据已经破坏、异常等情况）";

        new Setting(containerEl).setName("重置任务数据").setDesc("清空本地任务数据,并重新从云端获取任务到你的Obsidian").addButton(t => t.setButtonText("重置数据").setWarning().onClick(async () => {
            if (this.plugin.settings.accessToken) {
                if (confirm('确定要重置任务数据吗？\n\n此操作将：\n• 完全清空本地任务数据\n• 重新从滴答清单云端获取数据\n• 此操作不可逆\n\n点击"确定"继续，点击"取消"放弃操作。')) {
                    this.plugin.settings.tasks = [];
                    await this.plugin.saveSettings();
                    await this.plugin.syncManager.syncFromDidaList();
                }
            } else {
                new Notice("请先进行OAuth认证");
            }
        }));
    }

    updateRedirectUriDisplay(port: number) {
        this.containerEl.querySelectorAll("code").forEach(e => {
            if (e.textContent && e.textContent.includes("/callback")) {
                e.textContent = `http://localhost:${port}/callback`;
            }
        });
        this.containerEl.querySelectorAll("button").forEach(btn => {
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
