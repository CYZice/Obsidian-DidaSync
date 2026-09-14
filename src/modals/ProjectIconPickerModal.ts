import { Modal, setIcon } from "obsidian";
import DidaSyncPlugin from "../main";
import { ProjectCatalogEntry } from "../types";

export class ProjectIconPickerModal extends Modal {
    plugin: DidaSyncPlugin;
    project: ProjectCatalogEntry;
    onSelect: (iconName: string) => void | Promise<void>;
    filteredIcons: string[];
    iconItems: HTMLElement[];
    focusedIndex: number;

    constructor(app: any, plugin: DidaSyncPlugin, project: ProjectCatalogEntry, onSelect: (iconName: string) => void | Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.project = project;
        this.onSelect = onSelect;
        this.filteredIcons = [];
        this.iconItems = [];
        this.focusedIndex = 0;
    }

    onOpen() {
        const content = this.contentEl;
        content.empty();
        content.addClass("dida-icon-picker-modal");
        content.createEl("h3", { text: this.plugin.t("modal.iconPicker.title", { name: this.plugin.getProjectDisplayName(this.project.name) }) });

        const searchInput = content
            .createDiv("dida-icon-search-container")
            .createEl("input", {
                type: "text",
                placeholder: this.plugin.t("modal.iconPicker.searchPlaceholder")
            });
        searchInput.addClass("dida-icon-search-input");

        const grid = content.createDiv("dida-icon-grid-container");
        const buttonRow = content.createDiv("dida-icon-button-container");
        buttonRow.createEl("button", { text: this.plugin.t("modal.iconPicker.reset") }).addEventListener("click", async () => {
            await this.onSelect("");
            this.close();
        });
        buttonRow.createEl("button", { text: this.plugin.t("common.cancel") }).addEventListener("click", () => this.close());

        const renderIcons = (keyword: string = "") => {
            grid.empty();
            this.iconItems = [];
            const query = keyword.trim().toLowerCase();
            const icons = this.plugin.getLucideIconNames();
            this.filteredIcons = icons
                .filter((name) => !query || name.toLowerCase().includes(query))
                .slice(0, 200);
            if (this.filteredIcons.length === 0) {
                grid.createDiv({ text: this.plugin.t("modal.iconPicker.noResults"), cls: "dida-icon-no-results" });
                return;
            }
            this.filteredIcons.forEach((name, index) => {
                const item = grid.createDiv("dida-icon-grid-item");
                const preview = item.createDiv("dida-icon-preview");
                try {
                    setIcon(preview, `lucide-${name}`);
                } catch (e) {
                    preview.setText(name);
                }
                item.createDiv({ text: name, cls: "dida-icon-name" });
                item.addEventListener("click", async () => {
                    await this.onSelect(name);
                    this.close();
                });
                this.iconItems.push(item);
                if (index === this.focusedIndex) item.addClass("is-focused");
            });
        };

        const updateFocus = () => {
            this.iconItems.forEach((item, index) => {
                item.classList.toggle("is-focused", index === this.focusedIndex);
            });
            const active = this.iconItems[this.focusedIndex];
            if (active && typeof (active as any).scrollIntoView === "function") {
                active.scrollIntoView({ block: "nearest" });
            }
        };

        searchInput.addEventListener("input", (event: any) => {
            this.focusedIndex = 0;
            renderIcons(event.target.value || "");
        });
        searchInput.addEventListener("keydown", async (event) => {
            if (!this.iconItems.length) return;
            if (event.key === "ArrowRight") {
                event.preventDefault();
                this.focusedIndex = Math.min(this.focusedIndex + 1, this.iconItems.length - 1);
                updateFocus();
            } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                this.focusedIndex = Math.max(this.focusedIndex - 1, 0);
                updateFocus();
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                this.focusedIndex = Math.min(this.focusedIndex + 4, this.iconItems.length - 1);
                updateFocus();
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                this.focusedIndex = Math.max(this.focusedIndex - 4, 0);
                updateFocus();
            } else if (event.key === "Enter") {
                event.preventDefault();
                const selected = this.filteredIcons[this.focusedIndex];
                if (selected) {
                    await this.onSelect(selected);
                    this.close();
                }
            }
        });

        renderIcons();
        window.setTimeout(() => {
            searchInput.focus();
        }, 0);
    }

    onClose() {
        this.contentEl.empty();
    }
}
