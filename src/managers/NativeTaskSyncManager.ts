import DidaSyncPlugin from "../main";

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
                
                let match = line.match(/^(\s*)-\s*\[([ x])\]\s*(.*)$/);
                if (match) {
                    var [, indent, status, text] = match,
                        isCompleted = "x" === status.toLowerCase(),
                        linkMatch = text.match(/\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=([a-zA-Z0-9]+)\)/),
                        didaId = linkMatch ? linkMatch[1] : null,
                        hasLink = !!didaId;
                    
                    let title = text.trim();
                    title = title.replace(/\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-zA-Z0-9]+\)\s*/g, "").trim();
                    
                    var dateMatch = title.match(/📅\s*(\d{4}-\d{2}-\d{2})/),
                        taskDate = dateMatch ? dateMatch[1] : null;
                    
                    title = title.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*/g, "").trim();
                    
                    if (title && title.length !== 0) {
                        var id = this.generateTaskId(filePath, i, title);
                        tasks.push({
                            id: id,
                            title: title,
                            isCompleted: isCompleted,
                            didaId: didaId,
                            filePath: filePath,
                            lineNumber: i,
                            originalLine: line,
                            indent: indent,
                            hasLink: hasLink,
                            taskDate: taskDate
                        });
                    }
                }
            }
        }
        return tasks;
    }

    generateTaskId(filePath: string, lineNumber: number, title: string): string {
        return (filePath + `:${lineNumber}:` + title).replace(/[^a-zA-Z0-9]/g, "_");
    }
}
