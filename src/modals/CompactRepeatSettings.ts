import { App } from "obsidian";
import DidaSyncPlugin from "../main";
import { formatWeekdayNarrow, MessageKey, MessageParams, ResolvedLanguage, translateDefault, weekdayDate } from "../i18n";

export class CompactRepeatSettings {
    app: App;
    plugin: DidaSyncPlugin | null;
    onRepeatSet: (rrule: string) => void;
    triggerElement: HTMLElement | null;
    repeatType: string;
    interval: number;
    weekDay: number;
    monthDay: number;
    month: number;
    overlay: HTMLElement | null = null;
    container: HTMLElement | null = null;
    escapeHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor(app: App, plugin: DidaSyncPlugin | null, onRepeatSet: (rrule: string) => void, triggerElement: HTMLElement | null = null) {
        this.app = app;
        this.plugin = plugin;
        this.onRepeatSet = onRepeatSet;
        this.triggerElement = triggerElement;
        this.repeatType = "none";
        this.interval = 1;
        this.weekDay = 0;
        this.monthDay = 1;
        this.month = 1;
    }

    private t(key: MessageKey, params?: MessageParams): string {
        return this.plugin ? this.plugin.t(key, params) : translateDefault(key, params);
    }

    private getLanguage(): ResolvedLanguage {
        return this.plugin ? this.plugin.getUiLanguage() : "en";
    }

    show() {
        this.createOverlay();
        this.createContainer();
        this.positionContainer();
        this.renderContent();
        this.addEventListeners();
        document.body.appendChild(this.overlay!);
        window.requestAnimationFrame(() => {
            this.overlay!.classList.add("show");
        });
    }

    hide() {
        if (this.overlay) {
            this.overlay.classList.remove("show");
            setTimeout(() => {
                if (this.overlay && this.overlay.parentNode) {
                    this.overlay.parentNode.removeChild(this.overlay);
                }
                this.overlay = null;
                this.container = null;
            }, 200);
        }
        if (this.escapeHandler) {
            document.removeEventListener("keydown", this.escapeHandler);
            this.escapeHandler = null;
        }
    }

    createOverlay() {
        this.overlay = document.createElement("div");
        this.overlay.className = "dida-compact-repeat-overlay";
    }

    createContainer() {
        this.container = document.createElement("div");
        this.container.className = "dida-compact-repeat-container";
        this.overlay!.appendChild(this.container);
    }

    positionContainer() {
        if (this.triggerElement && this.container) {
            const rect = this.triggerElement.getBoundingClientRect();
            let top = rect.top - 250;
            let left = rect.left + rect.width / 2 - 165;

            if (top < 10) top = rect.bottom + 10;
            if (left < 10) left = 10;
            else if (left + 320 > window.innerWidth - 10) left = window.innerWidth - 330;

            this.container.setCssStyles({
                position: "fixed",
                top: `${top}px`,
                left: `${left}px`,
                zIndex: "10001"
            });
            this.overlay!.setCssStyles({
                justifyContent: "flex-start",
                alignItems: "flex-start"
            });
        }
    }

    renderContent() {
        if (!this.container) return;
        this.container.empty();

        const title = document.createElement("div");
        title.className = "dida-compact-repeat-title";
        title.textContent = this.t("repeat.title");
        this.container.appendChild(title);

        const typesDiv = document.createElement("div");
        typesDiv.className = "dida-compact-repeat-types";

        [
            { value: "none", label: this.t("repeat.none") },
            { value: "daily", label: this.t("repeat.daily") },
            { value: "weekly", label: this.t("repeat.weekly") },
            { value: "monthly", label: this.t("repeat.monthly") },
            { value: "yearly", label: this.t("repeat.yearly") }
        ].forEach((item) => {
            const btn = document.createElement("button");
            btn.className = "dida-compact-repeat-type-btn";
            if (item.value === this.repeatType) btn.classList.add("active");
            btn.textContent = item.label;
            btn.onclick = () => this.selectType(item.value);
            typesDiv.appendChild(btn);
        });

        this.container.appendChild(typesDiv);
        if (this.repeatType !== "none") this.renderDetails();

        const btnsDiv = document.createElement("div");
        btnsDiv.className = "dida-compact-repeat-buttons";

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "dida-compact-repeat-btn cancel";
        cancelBtn.textContent = this.t("common.cancel");
        cancelBtn.onclick = () => this.hide();

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "dida-compact-repeat-btn confirm";
        confirmBtn.textContent = this.t("common.confirm");
        confirmBtn.onclick = () => this.confirm();

        btnsDiv.append(cancelBtn, confirmBtn);
        this.container.appendChild(btnsDiv);
    }

    renderDetails() {
        if (!this.container) return;
        const details = this.container.querySelector(".dida-compact-repeat-details");
        if (details) details.remove();

        const newDetails = document.createElement("div");
        newDetails.className = "dida-compact-repeat-details";

        switch (this.repeatType) {
            case "daily":
                this.renderDailyDetails(newDetails);
                break;
            case "weekly":
                this.renderWeeklyDetails(newDetails);
                break;
            case "monthly":
                this.renderMonthlyDetails(newDetails);
                break;
            case "yearly":
                this.renderYearlyDetails(newDetails);
                break;
        }

        const btnsDiv = this.container.querySelector(".dida-compact-repeat-buttons");
        this.container.insertBefore(newDetails, btnsDiv);
    }

    renderDailyDetails(container: HTMLElement) {
        const div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.createEl("label", { text: this.t("repeat.every") });
        const input = div.createEl("input", {
            type: "number",
            cls: "interval-input"
        }) as HTMLInputElement;
        input.min = "1";
        input.max = "365";
        input.value = String(this.interval);
        div.createEl("label", { text: this.t("repeat.dailySuffix") });
        input.onchange = () => {
            this.interval = parseInt(input.value, 10) || 1;
        };
        container.appendChild(div);
    }

    renderWeeklyDetails(container: HTMLElement) {
        const div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.createEl("label", { text: this.t("repeat.every") });
        const input = div.createEl("input", {
            type: "number",
            cls: "interval-input"
        }) as HTMLInputElement;
        input.min = "1";
        input.max = "52";
        input.value = String(this.interval);
        div.createEl("label", { text: this.t("repeat.weeklySuffix") });
        input.onchange = () => {
            this.interval = parseInt(input.value, 10) || 1;
        };
        container.appendChild(div);

        const weekDiv = document.createElement("div");
        weekDiv.className = "dida-compact-weekday-container";
        const language = this.getLanguage();
        for (let index = 0; index < 7; index++) {
            const btn = document.createElement("button");
            btn.className = "dida-compact-weekday-btn";
            btn.textContent = formatWeekdayNarrow(weekdayDate(index), language);
            if (index === this.weekDay) btn.classList.add("active");
            btn.onclick = () => {
                weekDiv.querySelectorAll(".dida-compact-weekday-btn").forEach((item) => item.classList.remove("active"));
                btn.classList.add("active");
                this.weekDay = index;
            };
            weekDiv.appendChild(btn);
        }
        container.appendChild(weekDiv);
    }

    renderMonthlyDetails(container: HTMLElement) {
        const div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.createEl("label", { text: this.t("repeat.every") });
        const intervalInput = div.createEl("input", {
            type: "number",
            cls: "interval-input"
        }) as HTMLInputElement;
        intervalInput.min = "1";
        intervalInput.max = "12";
        intervalInput.value = String(this.interval);
        div.createEl("label", { text: this.t("repeat.compactMonthlyMid") });
        const dayInput = div.createEl("input", {
            type: "number",
            cls: "day-input"
        }) as HTMLInputElement;
        dayInput.min = "1";
        dayInput.max = "31";
        dayInput.value = String(this.monthDay);
        div.createEl("label", { text: this.t("repeat.compactDayTail") });
        intervalInput.onchange = () => {
            this.interval = parseInt(intervalInput.value, 10) || 1;
        };
        dayInput.onchange = () => {
            this.monthDay = parseInt(dayInput.value, 10) || 1;
        };
        container.appendChild(div);
    }

    renderYearlyDetails(container: HTMLElement) {
        const div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.createEl("label", { text: this.t("repeat.every") });
        const intervalInput = div.createEl("input", {
            type: "number",
            cls: "interval-input"
        }) as HTMLInputElement;
        intervalInput.min = "1";
        intervalInput.max = "10";
        intervalInput.value = String(this.interval);
        div.createEl("label", { text: this.t("repeat.compactYearlyMid") });
        const monthInput = div.createEl("input", {
            type: "number",
            cls: "month-input"
        }) as HTMLInputElement;
        monthInput.min = "1";
        monthInput.max = "12";
        monthInput.value = String(this.month);
        div.createEl("label", { text: this.t("repeat.compactMonthMid") });
        const dayInput = div.createEl("input", {
            type: "number",
            cls: "day-input"
        }) as HTMLInputElement;
        dayInput.min = "1";
        dayInput.max = "31";
        dayInput.value = String(this.monthDay);
        div.createEl("label", { text: this.t("repeat.compactDayTail") });

        intervalInput.onchange = () => {
            this.interval = parseInt(intervalInput.value, 10) || 1;
        };
        monthInput.onchange = () => {
            this.month = parseInt(monthInput.value, 10) || 1;
        };
        dayInput.onchange = () => {
            this.monthDay = parseInt(dayInput.value, 10) || 1;
        };
        container.appendChild(div);
    }

    selectType(type: string) {
        this.repeatType = type;
        this.renderContent();
    }

    addEventListeners() {
        if (!this.overlay) return;
        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.hide();
        };
        this.escapeHandler = (e) => {
            if (e.key === "Escape") this.hide();
        };
        document.addEventListener("keydown", this.escapeHandler);
    }

    confirm() {
        let rrule = "";
        if (this.repeatType !== "none") {
            rrule = this.generateRRule();
        }
        if (this.onRepeatSet) this.onRepeatSet(rrule);
        this.hide();
    }

    generateRRule() {
        let rrule = "RRULE:";
        switch (this.repeatType) {
            case "daily":
                rrule += `FREQ=DAILY;INTERVAL=${this.interval}`;
                break;
            case "weekly":
                rrule += `FREQ=WEEKLY;WKST=SU;INTERVAL=${this.interval};BYDAY=${["SU", "MO", "TU", "WE", "TH", "FR", "SA"][this.weekDay]}`;
                break;
            case "monthly":
                rrule += `FREQ=MONTHLY;INTERVAL=${this.interval};BYMONTHDAY=${this.monthDay}`;
                break;
            case "yearly":
                rrule += `FREQ=YEARLY;INTERVAL=${this.interval};BYMONTH=${this.month};BYMONTHDAY=${this.monthDay}`;
                break;
        }
        return rrule;
    }
}
