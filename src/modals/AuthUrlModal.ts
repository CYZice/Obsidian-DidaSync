import { App, Modal, Setting } from "obsidian";
import { shell } from "electron";

export class AuthUrlModal extends Modal {
    url: string;
    redirectUri: string;

    constructor(app: App, url: string, redirectUri: string) {
        super(app);
        this.url = url;
        this.redirectUri = redirectUri;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "认证链接" });
        contentEl.createEl("p", { text: "无法自动打开浏览器，请复制以下链接到浏览器中打开：" });
        
        const textArea = contentEl.createEl("textarea", { text: this.url });
        textArea.style.width = "100%";
        textArea.style.height = "100px";
        
        new Setting(contentEl).addButton(btn => {
            btn.setButtonText("复制链接")
                .onClick(() => {
                    textArea.select();
                    document.execCommand("copy");
                    btn.setButtonText("已复制");
                });
        });

        contentEl.createEl("p", { text: "认证完成后，请确保浏览器重定向到了: " + this.redirectUri });
    }

    onClose() {
        this.contentEl.empty();
    }
}
