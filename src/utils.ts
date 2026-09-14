import { IconName, setIcon } from "obsidian";
import { formatWeekdayShort, MessageKey, MessageParams, ResolvedLanguage, translate, weekdayDate } from "./i18n";
import { INBOX_PROJECT_NAME, LOCAL_PROJECT_NAME } from "./types";
export { ensureTaskCompletedTime, formatCompletedTime, normalizeRemoteCompletedTime } from "./taskCompletion";

export function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout | null;
    return function (this: any, ...args: Parameters<T>) {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(this, args);
        }, wait);
    };
}

export function normalizePomodoroPresetMinutes(
    presets: number[] | undefined,
    min: number,
    max: number,
    defaults: number[]
): number[] {
    let normalized = (Array.isArray(presets) ? presets : defaults)
        .map((value) => parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value) && value >= min && value <= max);
    normalized = Array.from(new Set(normalized)).sort((a, b) => a - b);
    return normalized.length > 0 ? normalized : defaults.slice();
}

export function normalizePomodoroCompletionHistory(
    history: Record<string, { sessions?: number; minutes?: number }> | undefined
): Record<string, { sessions: number; minutes: number }> {
    if (!history || typeof history !== "object") return {};
    const normalized: Record<string, { sessions: number; minutes: number }> = {};
    Object.entries(history).forEach(([key, value]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
        const sessions = parseInt(String(value?.sessions ?? 0), 10);
        const minutes = parseInt(String(value?.minutes ?? 0), 10);
        normalized[key] = {
            sessions: Number.isFinite(sessions) && sessions > 0 ? sessions : 0,
            minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 0
        };
    });
    return normalized;
}

export function getTimerRemainingSeconds(targetEndAt: number | null, now: number = Date.now()): number {
    if (!targetEndAt || !Number.isFinite(targetEndAt)) return 0;
    return Math.max(0, Math.ceil((targetEndAt - now) / 1000));
}

export function createDebouncedFunction<T extends (...args: any[]) => any>(
    func: T,
    wait: number
) {
    let timeout: NodeJS.Timeout | null;
    function debounced(this: any, ...args: Parameters<T>) {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(this, args);
        }, wait);
    }
    debounced.cleanup = function () {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    };
    return debounced;
}

export function compareVersions(v1: string, v2: string): number {
    if (!v1 || !v2) return 0;
    try {
        const parts1 = v1.split(".").map(v => parseInt(v, 10) || 0);
        const parts2 = v2.split(".").map(v => parseInt(v, 10) || 0);
        while (parts1.length < 3) parts1.push(0);
        while (parts2.length < 3) parts2.push(0);
        for (let i = 0; i < 3; i++) {
            if (parts1[i] < parts2[i]) return -1;
            if (parts1[i] > parts2[i]) return 1;
        }
        return 0;
    } catch (e) {
        return 0;
    }
}

export function compareProjectGroups(
    a: { name: string; taskCount: number },
    b: { name: string; taskCount: number },
    projectOrder: string[] = []
): number {
    const getBucket = ({ name, taskCount }: { name: string; taskCount: number }) => {
        if (name === INBOX_PROJECT_NAME) return 0;
        return taskCount > 0 ? 1 : 2;
    };

    const bucketA = getBucket(a);
    const bucketB = getBucket(b);
    if (bucketA !== bucketB) return bucketA - bucketB;

    if (a.name === LOCAL_PROJECT_NAME && b.name !== LOCAL_PROJECT_NAME) return 1;
    if (b.name === LOCAL_PROJECT_NAME && a.name !== LOCAL_PROJECT_NAME) return -1;

    const indexA = projectOrder.indexOf(a.name);
    const indexB = projectOrder.indexOf(b.name);

    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;

    return a.name.localeCompare(b.name);
}

export interface RepeatRuleDisplay {
    label: string;
    icon: IconName;
}

export function setIconElement(element: HTMLElement, icon: IconName) {
    while (element.firstChild) element.removeChild(element.firstChild);
    setIcon(element, icon);
}

export function setTextWithIcon(
    element: HTMLElement,
    text: string,
    icon: IconName,
    options?: {
        iconClass?: string;
        textClass?: string;
        textFirst?: boolean;
    }
) {
    while (element.firstChild) element.removeChild(element.firstChild);
    const iconEl = element.ownerDocument.createElement("span");
    if (options?.iconClass) iconEl.className = options.iconClass;
    setIcon(iconEl, icon);
    const textEl = element.ownerDocument.createElement("span");
    if (options?.textClass) textEl.className = options.textClass;
    textEl.textContent = text;
    if (options?.textFirst) {
        element.append(textEl, iconEl);
        return;
    }
    element.append(iconEl, textEl);
}

export function appendValidatedSvg(container: HTMLElement, svgMarkup: string): boolean {
    if (!svgMarkup || !svgMarkup.trim()) return false;
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.tagName.toLowerCase() !== "svg") return false;
    if (doc.querySelector("parsererror")) return false;
    svg.querySelectorAll("script").forEach((node) => node.remove());
    svg.querySelectorAll("*").forEach((node) => {
        Array.from(node.attributes).forEach((attr) => {
            if (attr.name.toLowerCase().startsWith("on")) node.removeAttribute(attr.name);
        });
    });
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(container.ownerDocument.importNode(svg, true));
    return true;
}

export function translateRepeatFlag(repeatFlag: string, language: ResolvedLanguage = "en"): RepeatRuleDisplay | null {
    if (!repeatFlag || "" === repeatFlag) return null;
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    try {
        const rruleStr = repeatFlag.startsWith("RRULE:") ? repeatFlag.substring(6) : repeatFlag;
        const rules: Record<string, string> = {};
        for (const part of rruleStr.split(";")) {
            const [key, value] = part.split("=");
            if (key && value) rules[key] = value;
        }
        const freq = rules.FREQ;
        const interval = parseInt(rules.INTERVAL || "1", 10) || 1;
        let text = "";
        switch (freq) {
            case "DAILY":
                text = interval === 1 ? t("repeat.display.daily") : t("repeat.display.everyDays", { interval });
                break;
            case "WEEKLY": {
                const byday = rules.BYDAY;
                if (byday) {
                    const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
                    const days = byday.split(",")
                        .map((day) => dayMap[day] === undefined ? day : formatWeekdayShort(weekdayDate(dayMap[day]), language))
                        .join(t("repeat.display.daysJoin"));
                    text = interval === 1
                        ? t("repeat.display.weeklyOn", { days })
                        : t("repeat.display.everyWeeksOn", { interval, days });
                } else {
                    text = interval === 1 ? t("repeat.display.weekly") : t("repeat.display.everyWeeks", { interval });
                }
                break;
            }
            case "MONTHLY": {
                const bymonthday = rules.BYMONTHDAY;
                text = bymonthday
                    ? (interval === 1 ? t("repeat.display.monthlyOnDay", { day: bymonthday }) : t("repeat.display.everyMonthsOnDay", { interval, day: bymonthday }))
                    : (interval === 1 ? t("repeat.display.monthly") : t("repeat.display.everyMonths", { interval }));
                break;
            }
            case "YEARLY": {
                const bymonth = rules.BYMONTH;
                const bymonthday = rules.BYMONTHDAY;
                text = bymonth && bymonthday
                    ? (interval === 1
                        ? t("repeat.display.yearlyOn", { month: bymonth, day: bymonthday })
                        : t("repeat.display.everyYearsOn", { interval, month: bymonth, day: bymonthday }))
                    : (interval === 1 ? t("repeat.display.yearly") : t("repeat.display.everyYears", { interval }));
                break;
            }
            default:
                text = t("repeat.display.repeat");
        }
        return { label: text, icon: "repeat" };
    } catch (e) {
        return { label: t("repeat.display.repeat"), icon: "repeat" };
    }
}

export function safeDecode(str: string): string {
    if (!str) return "";
    try {
        if (typeof decodeURIComponent !== "undefined") {
            return decodeURIComponent(str);
        }
    } catch (e) { }
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
        try {
            return Buffer.from(str, "base64").toString("utf8");
        } catch (e) { }
    }
    return "";
}
