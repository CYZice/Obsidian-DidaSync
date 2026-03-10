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

export function translateRepeatFlag(repeatFlag: string): string {
    if (!repeatFlag || "" === repeatFlag) return "";
    var icon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#858585" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-repeat-icon lucide-repeat"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';
    try {
        var part,
            rruleStr = repeatFlag.startsWith("RRULE:") ? repeatFlag.substring(6) : repeatFlag,
            rules: any = {};
        for (part of rruleStr.split(";")) {
            var [key, value] = part.split("=");
            if (key && value) rules[key] = value;
        }
        var freq = rules.FREQ,
            interval = parseInt(rules.INTERVAL) || 1;
        let text = "";
        switch (freq) {
            case "DAILY":
                text = 1 === interval ? "每天" : `每${interval}天`;
                break;
            case "WEEKLY":
                var byday = rules.BYDAY;
                if (byday) {
                    let map: any = {
                        SU: "周日",
                        MO: "周一",
                        TU: "周二",
                        WE: "周三",
                        TH: "周四",
                        FR: "周五",
                        SA: "周六"
                    };
                    var days = byday.split(",").map((d: string) => map[d] || d).join("、");
                    text = 1 === interval ? "每周" + days : `每${interval}周的` + days;
                } else text = 1 === interval ? "每周" : `每${interval}周`;
                break;
            case "MONTHLY":
                var bymonthday = rules.BYMONTHDAY;
                text = bymonthday ? 1 === interval ? `每月${bymonthday}日` : `每${interval}个月的${bymonthday}日` : 1 === interval ? "每月" : `每${interval}个月`;
                break;
            case "YEARLY":
                var bymonth = rules.BYMONTH,
                    bymonthday = rules.BYMONTHDAY;
                text = bymonth && bymonthday ? 1 === interval ? `每年${bymonth}月${bymonthday}日` : `每${interval}年的${bymonth}月${bymonthday}日` : 1 === interval ? "每年" : `每${interval}年`;
                break;
            default:
                text = "重复";
        }
        return text + " " + icon;
    } catch (e) {
        return "重复 " + icon;
    }
}
