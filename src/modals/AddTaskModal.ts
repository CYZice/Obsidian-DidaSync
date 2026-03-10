import { Modal, App } from 'obsidian';

export class AddTaskModal extends Modal {
    onSubmit: (title: string) => void;
    projectName: string;

    constructor(app: App, onSubmit: (title: string) => void, projectName: string = "收集箱") {
        super(app);
        this.onSubmit = onSubmit;
        this.projectName = projectName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "添加新任务到 " + this.projectName });

        const input = contentEl.createDiv().createEl("input", {
            type: "text",
            placeholder: "请输入任务标题"
        });
        input.style.width = "100%";
        input.style.marginBottom = "10px";

        const btnContainer = contentEl.createDiv();
        btnContainer.style.textAlign = "right";
        
        btnContainer.createEl("button", { text: "取消" }).onclick = () => this.close();
        
        const submitBtn = btnContainer.createEl("button", {
            text: "添加",
            cls: "mod-cta"
        });
        submitBtn.style.marginLeft = "10px";
        
        submitBtn.onclick = () => {
            const val = input.value.trim();
            if (val) {
                this.onSubmit(val);
                this.close();
            }
        };

        input.addEventListener("keypress", (e) => {
            if (e.key === "Enter") submitBtn.click();
        });

        setTimeout(() => input.focus(), 100);
    }

    onClose() {
        this.contentEl.empty();
    }
}
