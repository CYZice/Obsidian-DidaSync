import { App } from "obsidian";

export class CompactRepeatSettings {
    app: App;
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

    constructor(app: App, onRepeatSet: (rrule: string) => void, triggerElement: HTMLElement | null = null) {
        this.app = app;
        this.onRepeatSet = onRepeatSet;
        this.triggerElement = triggerElement;
        this.repeatType = "none";
        this.interval = 1;
        this.weekDay = 0;
        this.monthDay = 1;
        this.month = 1;
    }

    show() {
        this.createOverlay();
        this.createContainer();
        this.positionContainer();
        this.renderContent();
        this.addEventListeners();
        document.body.appendChild(this.overlay!);
        requestAnimationFrame(() => {
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
            var rect = this.triggerElement.getBoundingClientRect();
            let top = rect.top - 200 - 50;
            let left = rect.left + rect.width / 2 - 140 - 25;

            if (top < 10) top = rect.bottom + 10;
            if (left < 10) left = 10;
            else if (left + 280 > window.innerWidth - 10) left = window.innerWidth - 280 - 10;

            this.container.style.position = "fixed";
            this.container.style.top = top + "px";
            this.container.style.left = left + "px";
            this.container.style.zIndex = "10001";
            this.overlay!.style.justifyContent = "flex-start";
            this.overlay!.style.alignItems = "flex-start";
        }
    }

    renderContent() {
        if (!this.container) return;
        this.container.innerHTML = "";

        var title = document.createElement("div");
        title.className = "dida-compact-repeat-title";
        title.textContent = "重复设置";
        this.container.appendChild(title);

        let typesDiv = document.createElement("div");
        typesDiv.className = "dida-compact-repeat-types";

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
        }].forEach(t => {
            var btn = document.createElement("button");
            btn.className = "dida-compact-repeat-type-btn";
            if (t.value === this.repeatType) btn.classList.add("active");
            btn.textContent = t.label;
            btn.onclick = () => this.selectType(t.value);
            typesDiv.appendChild(btn);
        });

        this.container.appendChild(typesDiv);
        if ("none" !== this.repeatType) this.renderDetails();

        var btnsDiv = document.createElement("div");
        btnsDiv.className = "dida-compact-repeat-buttons";

        var cancelBtn = document.createElement("button");
        cancelBtn.className = "dida-compact-repeat-btn cancel";
        cancelBtn.textContent = "取消";
        cancelBtn.onclick = () => this.hide();

        var confirmBtn = document.createElement("button");
        confirmBtn.className = "dida-compact-repeat-btn confirm";
        confirmBtn.textContent = "确认";
        confirmBtn.onclick = () => this.confirm();

        btnsDiv.appendChild(cancelBtn);
        btnsDiv.appendChild(confirmBtn);
        this.container.appendChild(btnsDiv);
    }

    renderDetails() {
        if (!this.container) return;
        var details = this.container.querySelector(".dida-compact-repeat-details");
        if (details) details.remove();

        var newDetails = document.createElement("div");
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

        var btnsDiv = this.container.querySelector(".dida-compact-repeat-buttons");
        this.container.insertBefore(newDetails, btnsDiv);
    }

    renderDailyDetails(container: HTMLElement) {
        var div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.innerHTML = `
            <label>每</label>
            <input type="number" min="1" max="365" value="${this.interval}" class="interval-input">
            <label>天</label>
        `;
        let input = div.querySelector(".interval-input") as HTMLInputElement;
        input.onchange = () => {
            this.interval = parseInt(input.value) || 1;
        };
        container.appendChild(div);
    }

    renderWeeklyDetails(container: HTMLElement) {
        var div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.innerHTML = `
            <label>每</label>
            <input type="number" min="1" max="52" value="${this.interval}" class="interval-input">
            <label>周</label>
        `;
        let input = div.querySelector(".interval-input") as HTMLInputElement;
        input.onchange = () => {
            this.interval = parseInt(input.value) || 1;
        };
        container.appendChild(div);

        var weekDiv = document.createElement("div");
        weekDiv.className = "dida-compact-weekday-container";
        ["日", "一", "二", "三", "四", "五", "六"].forEach((day, index) => {
            let btn = document.createElement("button");
            btn.className = "dida-compact-weekday-btn";
            btn.textContent = day;
            if (index === this.weekDay) btn.classList.add("active");
            btn.onclick = () => {
                weekDiv.querySelectorAll(".dida-compact-weekday-btn").forEach(t => t.classList.remove("active"));
                btn.classList.add("active");
                this.weekDay = index;
            };
            weekDiv.appendChild(btn);
        });
        container.appendChild(weekDiv);
    }

    renderMonthlyDetails(container: HTMLElement) {
        var div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.innerHTML = `
            <label>每</label>
            <input type="number" min="1" max="12" value="${this.interval}" class="interval-input">
            <label>月的第</label>
            <input type="number" min="1" max="31" value="${this.monthDay}" class="day-input">
            <label>日</label>
        `;
        let intervalInput = div.querySelector(".interval-input") as HTMLInputElement;
        let dayInput = div.querySelector(".day-input") as HTMLInputElement;
        intervalInput.onchange = () => {
            this.interval = parseInt(intervalInput.value) || 1;
        };
        dayInput.onchange = () => {
            this.monthDay = parseInt(dayInput.value) || 1;
        };
        container.appendChild(div);
    }

    renderYearlyDetails(container: HTMLElement) {
        var div = document.createElement("div");
        div.className = "dida-compact-interval-container";
        div.innerHTML = `
            <label>每</label>
            <input type="number" min="1" max="10" value="${this.interval}" class="interval-input">
            <label>年的</label>
            <input type="number" min="1" max="12" value="${this.month}" class="month-input">
            <label>月</label>
            <input type="number" min="1" max="31" value="${this.monthDay}" class="day-input">
            <label>日</label>
        `;
        let intervalInput = div.querySelector(".interval-input") as HTMLInputElement;
        let monthInput = div.querySelector(".month-input") as HTMLInputElement;
        let dayInput = div.querySelector(".day-input") as HTMLInputElement;

        intervalInput.onchange = () => {
            this.interval = parseInt(intervalInput.value) || 1;
        };
        monthInput.onchange = () => {
            this.month = parseInt(monthInput.value) || 1;
        };
        dayInput.onchange = () => {
            this.monthDay = parseInt(dayInput.value) || 1;
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
            if ("Escape" === e.key) this.hide();
        };
        document.addEventListener("keydown", this.escapeHandler);
    }

    confirm() {
        let rrule = "";
        if ("none" !== this.repeatType) {
            rrule = this.generateRRule();
        }
        if (this.onRepeatSet) this.onRepeatSet(rrule);
        this.hide();
    }

    generateRRule() {
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
}
