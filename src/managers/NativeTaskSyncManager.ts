import DidaSyncPlugin from "../main";
import { formatTaskLine, parseTaskLine } from "../taskLineFormat";

export interface NativeTask {
    id: string;
    title: string;
    isCompleted: boolean;
    didaId: string | null;
    filePath: string;
    lineNumber: number;
    originalLine: string;
    indent: string;
    hasLink: boolean;
    taskDate: string | null;
    startDate: string | null;
    dueDate: string | null;
    isAllDay: boolean;
    priority: number;
    repeatFlag: string | null;
}

export class NativeTaskSyncManager {
    plugin: DidaSyncPlugin;
    taskRegex: RegExp;
    isOnline: boolean;

    constructor(plugin: DidaSyncPlugin) {
        this.plugin = plugin;
        this.taskRegex = /^(\s*)-\s*\[([ x])\]\s*(.+?)(\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-zA-Z0-9]+)\))?$/gm;
        this.isOnline = navigator.onLine;
        this.setupNetworkListeners();
    }

    setupNetworkListeners() {
        window.addEventListener("online", () => {
            this.isOnline = true;
        });
        window.addEventListener("offline", () => {
            this.isOnline = false;
        });
    }

    checkNetworkConnection(): boolean {
        return this.isOnline;
    }

    getNetworkStatus(): boolean {
        return this.isOnline;
    }

    detectNativeTasks(content: string, filePath: string): NativeTask[] {
        var tasks: NativeTask[] = [],
            lines = content.split("\n");
        let inCodeBlock = false,
            codeBlockLang = "";
        
        for (let i = 0; i < lines.length; i++) {
            var line = lines[i],
                codeBlockMatch = line.match(/^(\s*)```(\w*)/);
            
            if (codeBlockMatch) {
                if (inCodeBlock) {
                    inCodeBlock = false;
                    codeBlockLang = "";
                } else {
                    inCodeBlock = true;
                    codeBlockLang = codeBlockMatch[2] || "unknown";
                }
            } else if (!inCodeBlock) {
                if (line.includes("`")) {
                    let inlineCodeMatch = line.match(/^(\s*)-\s*\[([ x])\]\s*(.+)$/);
                    if (inlineCodeMatch && inlineCodeMatch[3].match(/^`[^`]*`$/)) continue;
                }
                
                const parsed = parseTaskLine(line);
                if (parsed) {
                    const taskDate = parsed.dueDate ? parsed.dueDate.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null : null;
                    if (parsed.title && parsed.title.length !== 0) {
                        var id = this.generateTaskId(filePath, i, parsed.title);
                        tasks.push({
                            id: id,
                            title: parsed.title,
                            isCompleted: parsed.checkbox === "x",
                            didaId: parsed.didaId,
                            filePath: filePath,
                            lineNumber: i,
                            originalLine: line,
                            indent: parsed.indent,
                            hasLink: !!parsed.didaId,
                            taskDate: taskDate,
                            startDate: parsed.startDate,
                            dueDate: parsed.dueDate,
                            isAllDay: parsed.isAllDay,
                            priority: parsed.priority,
                            repeatFlag: parsed.repeatFlag
                        });
                    }
                }
            }
        }
        return tasks;
    }

    normalizeAutoSyncTags(rawTags: string | null | undefined): string[] {
        return this.normalizeAutoSyncMarkers(rawTags)
            .map(tag => tag.startsWith("#") ? tag : `#${tag}`);
    }

    normalizeAutoSyncMarkers(rawMarkers: string | null | undefined): string[] {
        return String(rawMarkers || "")
            .split(/[\s,，]+/)
            .map(tag => tag.trim())
            .filter(Boolean)
            .map(tag => tag.toLowerCase());
    }

    fileMatchesAutoSyncTags(_content: string, rawTags: string | null | undefined, cache?: any): boolean {
        const targetTags = this.normalizeAutoSyncTags(rawTags);
        if (targetTags.length === 0) return false;

        const foundTags = new Set<string>();
        const addTag = (value: unknown) => {
            if (typeof value !== "string") return;
            const trimmed = value.trim();
            if (!trimmed) return;
            foundTags.add((trimmed.startsWith("#") ? trimmed : `#${trimmed}`).toLowerCase());
        };

        const frontmatterTags = cache?.frontmatter?.tags ?? cache?.frontmatter?.tag;
        if (Array.isArray(frontmatterTags)) frontmatterTags.forEach(addTag);
        else if (typeof frontmatterTags === "string") frontmatterTags.split(/[\s,，]+/).forEach(addTag);

        if (Array.isArray(cache?.tags)) {
            cache.tags.forEach((item: any) => addTag(item?.tag));
        }

        return targetTags.some(tag => foundTags.has(tag));
    }

    lineMatchesAutoSyncMarker(line: string, rawMarkers: string | null | undefined): boolean {
        const markers = this.normalizeAutoSyncMarkers(rawMarkers);
        if (markers.length === 0) return false;

        const normalizedLine = line.toLowerCase();
        return markers.some(marker => {
            if (marker.startsWith("#") || /^[a-z0-9_/-]+$/i.test(marker)) {
                const tag = marker.startsWith("#") ? marker : `#${marker}`;
                return this.lineHasExactTag(normalizedLine, tag);
            }
            return normalizedLine.includes(marker);
        });
    }

    private lineHasExactTag(line: string, tag: string): boolean {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[\\s([{'"<])${escaped}(?=$|[\\s,，.。;；:：!?！？)\\]}'">])`).test(line);
    }

    withDidaLink(content: string, lineNumber: number, didaId: string): string {
        const lines = content.split("\n");
        if (lineNumber < 0 || lineNumber >= lines.length) return content;
        const parsed = parseTaskLine(lines[lineNumber]);
        if (!parsed || parsed.didaId) return content;
        lines[lineNumber] = formatTaskLine(lines[lineNumber], { didaId });
        return lines.join("\n");
    }

    generateTaskId(filePath: string, lineNumber: number, title: string): string {
        return (filePath + `:${lineNumber}:` + title).replace(/[^a-zA-Z0-9]/g, "_");
    }
}
