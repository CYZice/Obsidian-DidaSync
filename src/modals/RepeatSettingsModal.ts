import { App, Modal } from "obsidian";

export class RepeatSettingsModal extends Modal {
    onRepeatSet: (rrule: string) => void;
    repeatType: string = "none";
    interval: number = 1;
    weekDay: number = 0;
    monthDay: number = 1;
    month: number = 1;
    yearWeekDay: number = 0;
    yearWeekNumber: number = 1;
    customRRule: HTMLTextAreaElement | null = null;

    constructor(app: App, onRepeatSet: (rrule: string) => void) {
        super(app);
        this.onRepeatSet = onRepeatSet;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("dida-repeat-settings-modal");
        contentEl.createEl("h2", { text: "重复设置" });
        
        const typeContainer = contentEl.createDiv("dida-repeat-type-container");
        typeContainer.createEl("h3", { text: "重复类型" });
        
        let select = typeContainer.createEl("select", { cls: "dida-repeat-type-select" });
        
        [{
            value: "none",
            label: "不重复"
        }, {
            value: "daily",
            label: "每天"
        }, {
            value: "weekly",
            label: "每周"
        }, {
            value: "monthly",
            label: "每月"
        }, {
            value: "yearly",
            label: "每年"
        }, {
            value: "custom",
            label: "自定义"
        }].forEach(t => {
            var opt = select.createEl("option", {
                value: t.value,
                text: t.label
            });
            if (t.value === this.repeatType) opt.selected = true;
        });

        const detailsContainer = typeContainer.createDiv("dida-repeat-details-container");
        
        select.onchange = () => {
            this.repeatType = select.value;
            this.renderDetails(detailsContainer);
        };
        
        this.renderDetails(detailsContainer);
        
        const buttons = contentEl.createDiv("dida-repeat-buttons");
        buttons.createEl("button", { text: "取消" }).onclick = () => this.close();
        buttons.createEl("button", { text: "确认", cls: "mod-cta" }).onclick = () => {
            var rrule = this.generateRRULE();
            this.onRepeatSet(rrule);
            this.close();
        };
    }

    renderDetails(container: HTMLElement) {
        container.empty();
        if (this.repeatType !== "none") {
            if (this.repeatType === "daily") this.renderDailySettings(container);
            else if (this.repeatType === "weekly") this.renderWeeklySettings(container);
            else if (this.repeatType === "monthly") this.renderMonthlySettings(container);
            else if (this.repeatType === "yearly") this.renderYearlySettings(container);
            else if (this.repeatType === "custom") this.renderCustomSettings(container);
        }
    }

    renderDailySettings(container: HTMLElement) {
        const settings = container.createDiv("dida-daily-settings");
        settings.createEl("h4", { text: "每日重复设置" });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: "每" });
        let input = intervalContainer.createEl("input", {
            type: "number",
            value: this.interval.toString(),
            cls: "dida-interval-input"
        });
        input.min = "1";
        input.max = "365";
        input.onchange = () => {
            this.interval = parseInt(input.value) || 1;
        };
        intervalContainer.createEl("span", { text: "天重复一次" });
    }

    renderWeeklySettings(container: HTMLElement) {
        const settings = container.createDiv("dida-weekly-settings");
        settings.createEl("h4", { text: "每周重复设置" });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: "每" });
        let input = intervalContainer.createEl("input", {
            type: "number",
            value: this.interval.toString(),
            cls: "dida-interval-input"
        });
        input.min = "1";
        input.max = "52";
        input.onchange = () => {
            this.interval = parseInt(input.value) || 1;
        };
        intervalContainer.createEl("span", { text: "周重复一次" });
        
        const weekdayContainer = settings.createDiv("dida-weekday-container");
        weekdayContainer.createEl("span", { text: "在星期：" });
        let select = weekdayContainer.createEl("select", { cls: "dida-weekday-select" });
        ["日", "一", "二", "三", "四", "五", "六"].forEach((t, e) => {
            let opt = select.createEl("option", {
                value: e.toString(),
                text: "星期" + t
            });
            if (e === this.weekDay) opt.selected = true;
        });
        select.onchange = () => {
            this.weekDay = parseInt(select.value);
        };
    }

    renderMonthlySettings(container: HTMLElement) {
        const settings = container.createDiv("dida-monthly-settings");
        settings.createEl("h4", { text: "每月重复设置" });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: "每" });
        let input = intervalContainer.createEl("input", {
            type: "number",
            value: this.interval.toString(),
            cls: "dida-interval-input"
        });
        input.min = "1";
        input.max = "12";
        input.onchange = () => {
            this.interval = parseInt(input.value) || 1;
        };
        intervalContainer.createEl("span", { text: "月重复一次" });
        
        const monthdayContainer = settings.createDiv("dida-monthday-container");
        monthdayContainer.createEl("span", { text: "在每月第" });
        let dayInput = monthdayContainer.createEl("input", {
            type: "number",
            value: this.monthDay.toString(),
            cls: "dida-monthday-input"
        });
        dayInput.min = "1";
        dayInput.max = "31";
        dayInput.onchange = () => {
            this.monthDay = parseInt(dayInput.value) || 1;
        };
        monthdayContainer.createEl("span", { text: "日" });
    }

    renderYearlySettings(container: HTMLElement) {
        const settings = container.createDiv("dida-yearly-settings");
        settings.createEl("h4", { text: "每年重复设置" });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: "每" });
        let input = intervalContainer.createEl("input", {
            type: "number",
            value: this.interval.toString(),
            cls: "dida-interval-input"
        });
        input.min = "1";
        input.max = "10";
        input.onchange = () => {
            this.interval = parseInt(input.value) || 1;
        };
        intervalContainer.createEl("span", { text: "年重复一次" });
        
        const monthContainer = settings.createDiv("dida-month-container");
        monthContainer.createEl("span", { text: "在" });
        let monthSelect = monthContainer.createEl("select", { cls: "dida-month-select" });
        for (let t = 1; t <= 12; t++) {
            let opt = monthSelect.createEl("option", {
                value: t.toString(),
                text: t + "月"
            });
            if (t === this.month) opt.selected = true;
        }
        monthSelect.onchange = () => {
            this.month = parseInt(monthSelect.value);
        };
        
        const yeardayContainer = settings.createDiv("dida-yearday-container");
        yeardayContainer.createEl("span", { text: "第" });
        let dayInput = yeardayContainer.createEl("input", {
            type: "number",
            value: this.monthDay.toString(),
            cls: "dida-yearday-input"
        });
        dayInput.min = "1";
        dayInput.max = "31";
        dayInput.onchange = () => {
            this.monthDay = parseInt(dayInput.value) || 1;
        };
        yeardayContainer.createEl("span", { text: "日" });
    }

    renderCustomSettings(container: HTMLElement) {
        const settings = container.createDiv("dida-custom-settings");
        settings.createEl("h4", { text: "自定义重复设置" });
        const rruleContainer = settings.createDiv("dida-rrule-container");
        rruleContainer.createEl("label", { text: "直接输入RRULE格式：" });
        this.customRRule = rruleContainer.createEl("textarea", {
            cls: "dida-rrule-input",
            placeholder: "例如：RRULE:FREQ=DAILY;INTERVAL=1"
        });
        this.customRRule.rows = 3;
    }

    generateRRULE() {
        if (this.repeatType === "none") return "";
        if (this.repeatType === "custom") return this.customRRule ? this.customRRule.value.trim() : "";
        
        let rrule = "RRULE:";
        switch (this.repeatType) {
            case "daily":
                rrule += "FREQ=DAILY;INTERVAL=" + this.interval;
                break;
            case "weekly":
                rrule += `FREQ=WEEKLY;WKST=SU;INTERVAL=${this.interval};BYDAY=` + ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][this.weekDay];
                break;
            case "monthly":
                rrule += `FREQ=MONTHLY;INTERVAL=${this.interval};BYMONTHDAY=` + this.monthDay;
                break;
            case "yearly":
                rrule += `FREQ=YEARLY;INTERVAL=${this.interval};BYMONTH=${this.month};BYMONTHDAY=` + this.monthDay;
                break;
        }
        return rrule;
    }

    onClose() {
        this.contentEl.empty();
    }
}
