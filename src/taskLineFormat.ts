import { DidaTask } from "./types";

export interface ParsedTaskLine {
    quotePrefix: string;
    indent: string;
    checkbox: string;
    title: string;
    didaId: string | null;
    startDate: string | null;
    dueDate: string | null;
    isAllDay: boolean;
    priority: number;
    repeatFlag: string | null;
    disconnected: boolean;
}

export interface TaskLineMetadata {
    checkbox?: " " | "x";
    title?: string;
    didaId?: string | null;
    startDate?: string | null;
    dueDate?: string | null;
    isAllDay?: boolean;
    priority?: number;
    repeatFlag?: string | null;
    disconnected?: boolean;
}

const DIDA_LINK_RE = /\[[^\]]*Dida[^\]]*\]\(obsidian:\/\/dida-task\?didaId=([a-zA-Z0-9]+)\)/;
const ANY_DIDA_LINK_RE = /\s*\[[^\]]*Dida[^\]]*\]\(obsidian:\/\/dida-task\?didaId=[a-zA-Z0-9]+\)\s*/g;
const TIME_RANGE_RE = /\[(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\]/;
const DUE_DATE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const REPEAT_RE = /🔁\s*(every\s+[^📅🔴🟡🔵⚪]+)/i;
const PRIORITY_RE = /🔴|🟡|🔵|⚪/g;
const DISCONNECTED_RE = /(?:^|\s)🗑️(?=\s|$)/;

export function parseTaskLine(line: string): ParsedTaskLine | null {
    const match = line.match(/^((?:\s*>\s*)*)(\s*)-\s*\[([ xX])\]\s*(.*)$/);
    if (!match) return null;

    const quotePrefix = match[1] || "";
    const indent = match[2] || "";
    const checkbox = match[3].toLowerCase() === "x" ? "x" : " ";
    let body = match[4] || "";

    const linkMatch = body.match(DIDA_LINK_RE);
    const didaId = linkMatch ? linkMatch[1] : null;

    const timeRangeMatch = body.match(TIME_RANGE_RE);
    const dueDateMatch = body.match(DUE_DATE_RE);
    const repeatMatch = body.match(REPEAT_RE);

    const priority = parsePriority(body);
    const repeatFlag = repeatMatch ? tasksRepeatToRRule(repeatMatch[1].trim()) : null;
    const disconnected = DISCONNECTED_RE.test(body);

    let startDate: string | null = null;
    let dueDate: string | null = null;
    let isAllDay = true;

    const bareDates = Array.from(body.matchAll(/\d{4}-\d{2}-\d{2}/g)).map(m => m[0]);
    const dueDay = dueDateMatch ? dueDateMatch[1] : (bareDates.length >= 1 ? bareDates[bareDates.length - 1] : null);
    const startDay = bareDates.length >= 2 ? bareDates[0] : dueDay;

    if (timeRangeMatch && dueDay) {
        const sh = parseInt(timeRangeMatch[1], 10);
        const sm = parseInt(timeRangeMatch[2], 10);
        const eh = parseInt(timeRangeMatch[3], 10);
        const em = parseInt(timeRangeMatch[4], 10);
        const startBase = startDay || dueDay;
        const dueBase = dueDay || startBase;
        startDate = makeLocalDateTime(startBase, sh, sm);
        dueDate = makeLocalDateTime(dueBase, eh, em);
        isAllDay = false;
    } else {
        if (dueDay) dueDate = makeLocalDateTime(dueDay, 0, 0);
        if (dueDay) startDate = dueDate;
        isAllDay = true;
    }

    let title = body
        .replace(ANY_DIDA_LINK_RE, " ")
        .replace(TIME_RANGE_RE, " ")
        .replace(DUE_DATE_RE, " ")
        .replace(REPEAT_RE, " ")
        .replace(PRIORITY_RE, " ")
        .replace(DISCONNECTED_RE, " ")
        .replace(/\s+\d{4}-\d{2}-\d{2}\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return { quotePrefix, indent, checkbox, title, didaId, startDate, dueDate, isAllDay, priority, repeatFlag, disconnected };
}

export function formatTaskLine(line: string, metadata: TaskLineMetadata): string {
    const parsed = parseTaskLine(line);
    if (!parsed) return line;
    return buildTaskLine({
        ...parsed,
        ...metadata,
        checkbox: metadata.checkbox !== undefined ? metadata.checkbox : parsed.checkbox,
        title: metadata.title !== undefined ? metadata.title : parsed.title,
        didaId: metadata.didaId !== undefined ? metadata.didaId : parsed.didaId,
        startDate: metadata.startDate !== undefined ? metadata.startDate : parsed.startDate,
        dueDate: metadata.dueDate !== undefined ? metadata.dueDate : parsed.dueDate,
        isAllDay: metadata.isAllDay !== undefined ? metadata.isAllDay : parsed.isAllDay,
        priority: metadata.priority !== undefined ? metadata.priority : parsed.priority,
        repeatFlag: metadata.repeatFlag !== undefined ? metadata.repeatFlag : parsed.repeatFlag,
        disconnected: metadata.disconnected !== undefined ? metadata.disconnected : parsed.disconnected
    });
}

export function formatTaskLineFromTask(task: DidaTask, indent: string = "", quotePrefix: string = ""): string {
    return buildTaskLine({
        quotePrefix,
        indent,
        checkbox: task.status === 2 ? "x" : " ",
        title: (task.title || "").replace(/\r?\n/g, " ").trim() || "无标题任务",
        didaId: task.didaId || task.id || null,
        startDate: task.startDate || null,
        dueDate: task.dueDate || null,
        isAllDay: task.isAllDay === true,
        priority: task.priority || 0,
        repeatFlag: task.repeatFlag || null,
        disconnected: false
    });
}

export function applyParsedLineToTask(task: DidaTask, parsed: ParsedTaskLine) {
    task.title = parsed.title;
    task.startDate = parsed.startDate as any;
    task.dueDate = parsed.dueDate as any;
    task.isAllDay = parsed.isAllDay;
    task.priority = parsed.priority;
    task.repeatFlag = parsed.repeatFlag as any;
}

export function makeLocalDateTime(date: string, hour: number, minute: number): string {
    const [year, month, day] = date.split("-").map(v => parseInt(v, 10));
    const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
    return formatLocalDateTime(dt);
}

export function formatDateOnly(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildTaskLine(parts: ParsedTaskLine): string {
    const checkbox = parts.checkbox.toLowerCase() === "x" ? "x" : " ";
    const title = (parts.title || "").trim() || "无标题任务";
    const link = parts.didaId ? ` [🔗Dida](obsidian://dida-task?didaId=${parts.didaId})` : "";
    const disconnected = parts.disconnected && !parts.didaId ? " 🗑️" : "";
    const metadata = formatMetadata(parts);
    return `${parts.quotePrefix || ""}${parts.indent}- [${checkbox}] ${title}${link}${metadata}${disconnected}`.trimEnd();
}

function formatMetadata(parts: ParsedTaskLine): string {
    const out: string[] = [];
    const dueDay = formatDateOnly(parts.dueDate);

    if (!parts.isAllDay && parts.startDate && parts.dueDate) {
        out.push(`[${formatTime(parts.startDate)} - ${formatTime(parts.dueDate)}]`);
    }
    if (dueDay) out.push(`📅 ${dueDay}`);

    const priority = formatPriority(parts.priority);
    if (priority) out.push(priority);

    const repeat = rruleToTasksRepeat(parts.repeatFlag);
    if (repeat) out.push(`🔁 ${repeat}`);

    return out.length > 0 ? " " + out.join(" ") : "";
}

function formatLocalDateTime(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    const offset = date.getTimezoneOffset();
    const oh = String(Math.abs(Math.floor(offset / 60))).padStart(2, "0");
    const om = String(Math.abs(offset % 60)).padStart(2, "0");
    const tz = (offset <= 0 ? "+" : "-") + oh + om;
    return `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
}

function formatTime(value: string): string {
    const date = new Date(value);
    if (isNaN(date.getTime())) return "00:00";
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function parsePriority(text: string): number {
    if (/🔴/.test(text)) return 5;
    if (/🟡/.test(text)) return 3;
    if (/🔵/.test(text)) return 1;
    if (/⚪/.test(text)) return 0;
    return 0;
}

function formatPriority(priority?: number): string {
    if (priority === 5) return "🔴";
    if (priority === 3) return "🟡";
    if (priority === 1) return "🔵";
    return "";
}

export function tasksRepeatToRRule(text: string): string | null {
    const normalized = text.trim().toLowerCase();
    const match = normalized.match(/^every\s+(?:(\d+)\s+)?(day|days|week|weeks|month|months|year|years)\b/);
    if (!match) return null;
    const interval = parseInt(match[1] || "1", 10) || 1;
    const unit = match[2];
    if (unit.startsWith("day")) return `RRULE:FREQ=DAILY;INTERVAL=${interval}`;
    if (unit.startsWith("week")) return `RRULE:FREQ=WEEKLY;INTERVAL=${interval}`;
    if (unit.startsWith("month")) return `RRULE:FREQ=MONTHLY;INTERVAL=${interval}`;
    if (unit.startsWith("year")) return `RRULE:FREQ=YEARLY;INTERVAL=${interval}`;
    return null;
}

export function rruleToTasksRepeat(rrule: string | null | undefined): string | null {
    if (!rrule) return null;
    const rules: Record<string, string> = {};
    const raw = rrule.startsWith("RRULE:") ? rrule.substring(6) : rrule;
    raw.split(";").forEach(part => {
        const [key, value] = part.split("=");
        if (key && value) rules[key] = value;
    });
    const interval = parseInt(rules.INTERVAL || "1", 10) || 1;
    const unit = rules.FREQ === "DAILY" ? "day" : rules.FREQ === "WEEKLY" ? "week" : rules.FREQ === "MONTHLY" ? "month" : rules.FREQ === "YEARLY" ? "year" : null;
    if (!unit) return null;
    return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
}
