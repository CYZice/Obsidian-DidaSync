import { App, Modal } from "obsidian";
import DidaSyncPlugin from "../main";
import { formatMonthName, formatWeekdayLong, ResolvedLanguage, weekdayDate } from "../i18n";

export class RepeatSettingsModal extends Modal {
    plugin: DidaSyncPlugin;
    onRepeatSet: (rrule: string) => void;
    repeatType: string = "none";
    interval: number = 1;
    weekDay: number = 0;
    monthDay: number = 1;
    month: number = 1;
    yearWeekDay: number = 0;
    yearWeekNumber: number = 1;
    customRRule: HTMLTextAreaElement | null = null;

    constructor(app: App, plugin: DidaSyncPlugin, onRepeatSet: (rrule: string) => void) {
        super(app);
        this.plugin = plugin;
        this.onRepeatSet = onRepeatSet;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("dida-repeat-settings-modal");
        contentEl.createEl("h2", { text: this.plugin.t("repeat.title") });

        const typeContainer = contentEl.createDiv("dida-repeat-type-container");
        typeContainer.createEl("h3", { text: this.plugin.t("repeat.typeHeading") });

        let select = typeContainer.createEl("select", { cls: "dida-repeat-type-select" });

        [{
            value: "none",
            label: this.plugin.t("repeat.none")
        }, {
            value: "daily",
            label: this.plugin.t("repeat.daily")
        }, {
            value: "weekly",
            label: this.plugin.t("repeat.weekly")
        }, {
            value: "monthly",
            label: this.plugin.t("repeat.monthly")
        }, {
            value: "yearly",
            label: this.plugin.t("repeat.yearly")
        }, {
            value: "custom",
            label: this.plugin.t("repeat.custom")
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
        buttons.createEl("button", { text: this.plugin.t("common.cancel") }).onclick = () => this.close();
        buttons.createEl("button", { text: this.plugin.t("common.confirm"), cls: "mod-cta" }).onclick = () => {
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
        settings.createEl("h4", { text: this.plugin.t("repeat.dailyHeading") });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.every") });
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
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.dailySuffix") });
    }

    renderWeeklySettings(container: HTMLElement) {
        const settings = container.createDiv("dida-weekly-settings");
        settings.createEl("h4", { text: this.plugin.t("repeat.weeklyHeading") });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.every") });
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
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.weeklySuffix") });

        const weekdayContainer = settings.createDiv("dida-weekday-container");
        weekdayContainer.createEl("span", { text: this.plugin.t("repeat.onWeekday") });
        let select = weekdayContainer.createEl("select", { cls: "dida-weekday-select" });
        this.getWeekdayLabels().forEach((label, e) => {
            let opt = select.createEl("option", {
                value: e.toString(),
                text: label
            });
            if (e === this.weekDay) opt.selected = true;
        });
        select.onchange = () => {
            this.weekDay = parseInt(select.value);
        };
    }

    renderMonthlySettings(container: HTMLElement) {
        const settings = container.createDiv("dida-monthly-settings");
        settings.createEl("h4", { text: this.plugin.t("repeat.monthlyHeading") });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.every") });
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
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.monthlySuffix") });

        const monthdayContainer = settings.createDiv("dida-monthday-container");
        monthdayContainer.createEl("span", { text: this.plugin.t("repeat.onMonthDay") });
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
        monthdayContainer.createEl("span", { text: this.plugin.t("repeat.monthDaySuffix") });
    }

    renderYearlySettings(container: HTMLElement) {
        const settings = container.createDiv("dida-yearly-settings");
        settings.createEl("h4", { text: this.plugin.t("repeat.yearlyHeading") });
        const intervalContainer = settings.createDiv("dida-interval-container");
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.every") });
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
        intervalContainer.createEl("span", { text: this.plugin.t("repeat.yearlySuffix") });

        const monthContainer = settings.createDiv("dida-month-container");
        monthContainer.createEl("span", { text: this.plugin.t("repeat.onMonth") });
        let monthSelect = monthContainer.createEl("select", { cls: "dida-month-select" });
        for (let t = 1; t <= 12; t++) {
            let opt = monthSelect.createEl("option", {
                value: t.toString(),
                text: formatMonthName(t - 1, this.getLanguage())
            });
            if (t === this.month) opt.selected = true;
        }
        monthSelect.onchange = () => {
            this.month = parseInt(monthSelect.value);
        };
        
        const yeardayContainer = settings.createDiv("dida-yearday-container");
        yeardayContainer.createEl("span", { text: this.plugin.t("repeat.yearDayPrefix") });
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
        yeardayContainer.createEl("span", { text: this.plugin.t("repeat.daySuffix") });

        const orContainer = settings.createDiv("dida-or-container");
        orContainer.createEl("span", { text: this.plugin.t("repeat.orWeekNumberPrefix") });
        let weekNumInput = orContainer.createEl("input", {
            type: "number",
            value: this.yearWeekNumber.toString(),
            cls: "dida-week-number-input"
        });
        weekNumInput.min = "1";
        weekNumInput.max = "5";
        weekNumInput.onchange = () => {
            this.yearWeekNumber = parseInt(weekNumInput.value) || 1;
        };
        orContainer.createEl("span", { text: this.plugin.t("repeat.weekNumberSuffix") });
        let weekDaySelect = orContainer.createEl("select", {
            cls: "dida-year-weekday-select"
        });
        this.getWeekdayLabels().forEach((label, e) => {
            let opt = weekDaySelect.createEl("option", {
                value: e.toString(),
                text: label
            });
            if (e === this.yearWeekDay) opt.selected = true;
        });
        weekDaySelect.onchange = () => {
            this.yearWeekDay = parseInt(weekDaySelect.value);
        };
    }

    renderCustomSettings(container: HTMLElement) {
        const settings = container.createDiv("dida-custom-settings");
        settings.createEl("h4", { text: this.plugin.t("repeat.customHeading") });
        const rruleContainer = settings.createDiv("dida-rrule-container");
        rruleContainer.createEl("label", { text: this.plugin.t("repeat.customLabel") });
        this.customRRule = rruleContainer.createEl("textarea", {
            cls: "dida-rrule-input",
            placeholder: this.plugin.t("repeat.customPlaceholder")
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
                if (this.yearWeekNumber > 0 && this.yearWeekDay >= 0) {
                    rrule += `FREQ=YEARLY;INTERVAL=${this.interval};BYMONTH=${this.month};BYDAY=` + this.yearWeekNumber + ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][this.yearWeekDay];
                } else {
                    rrule += `FREQ=YEARLY;INTERVAL=${this.interval};BYMONTH=${this.month};BYMONTHDAY=` + this.monthDay;
                }
                break;
        }
        return rrule;
    }

    onClose() {
        this.contentEl.empty();
    }

    private getLanguage(): ResolvedLanguage {
        return this.plugin.getUiLanguage();
    }

    private getWeekdayLabels(): string[] {
        const language = this.getLanguage();
        return Array.from({ length: 7 }, (_, index) => formatWeekdayLong(weekdayDate(index), language));
    }
}
