export class RRuleParser {
    static calculateNextDueDate(rrule: string, currentDate: string): string | null {
        if (!rrule || !currentDate) return null;
        try {
            var rules = this.parseRRule(rrule),
                date = new Date(currentDate);
            switch (rules.FREQ) {
                case "DAILY":
                    return this.calculateDailyNext(date, rules);
                case "WEEKLY":
                    return this.calculateWeeklyNext(date, rules);
                case "MONTHLY":
                    return this.calculateMonthlyNext(date, rules);
                case "YEARLY":
                    return this.calculateYearlyNext(date, rules);
                default:
                    return null;
            }
        } catch (t) {
            return null;
        }
    }
    static parseRRule(rrule: string): any {
        var part, rules: any = {};
        for (part of (rrule.startsWith("RRULE:") ? rrule.substring(6) : rrule).split(";")) {
            var [key, value] = part.split("=");
            if (key && value) rules[key] = value;
        }
        return rules;
    }
    static calculateDailyNext(date: Date, rules: any): string {
        var interval = parseInt(rules.INTERVAL) || 1;
        date.setDate(date.getDate() + interval);
        return date.toISOString();
    }
    static calculateWeeklyNext(date: Date, rules: any): string {
        var interval = parseInt(rules.INTERVAL) || 1;
        
        if (rules.BYDAY) {
            let dayMap: any = {
                SU: 0,
                MO: 1,
                TU: 2,
                WE: 3,
                TH: 4,
                FR: 5,
                SA: 6
            };
            let targetDay = dayMap[rules.BYDAY.split(",")[0]];
            if (void 0 !== targetDay) {
                let diff = targetDay - date.getDay();
                if (diff <= 0) {
                    diff += 7 * interval;
                } else if (interval > 1) {
                    diff += 7 * (interval - 1);
                }
                date.setDate(date.getDate() + diff);
            } else {
                date.setDate(date.getDate() + 7 * interval);
            }
        } else {
            date.setDate(date.getDate() + 7 * interval);
        }
        return date.toISOString();
    }
    static calculateMonthlyNext(date: Date, rules: any): string {
        var interval = parseInt(rules.INTERVAL) || 1;
        if (rules.BYMONTHDAY) {
            var day = parseInt(rules.BYMONTHDAY);
            date.setMonth(date.getMonth() + interval);
            date.setDate(day);
        } else {
            date.setMonth(date.getMonth() + interval);
        }
        return date.toISOString();
    }
    static calculateYearlyNext(date: Date, rules: any): string {
        var interval = parseInt(rules.INTERVAL) || 1;
        date.setFullYear(date.getFullYear() + interval);
        return date.toISOString();
    }
    static hasRepeatRule(task: any): boolean {
        return task.repeatFlag && "" !== task.repeatFlag.trim();
    }
}
