/**
 * Markdown document helpers for synced Dida notes.
 *
 * The note body is plain Markdown; only a small block of `dida*` frontmatter
 * keys is owned by the plugin. Any other frontmatter the user or another
 * plugin adds must survive a sync write, so rendering accepts the previous
 * raw frontmatter lines and re-emits everything the plugin does not manage.
 */

export interface ParsedNoteFile {
    frontmatter: Record<string, any>;
    body: string;
    /** Raw frontmatter lines (without the `---` fences). */
    frontmatterLines: string[];
}

/** Frontmatter keys written by the plugin on every sync. */
export const MANAGED_FRONTMATTER_KEYS = [
    "didaNoteId",
    "didaNoteKind",
    "didaNoteSyncStatus",
    "didaEtag",
    "didaModifiedTime",
    "didaLastSyncedContentHash",
    "didaLastSyncedAt"
] as const;

const MANAGED_KEY_SET = new Set<string>(MANAGED_FRONTMATTER_KEYS);
const FRONTMATTER_KEY_PATTERN = /^([A-Za-z0-9_.-]+)\s*:/;

export function parseNoteFile(content: string): ParsedNoteFile {
    const normalized = String(content ?? "").replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) {
        return { frontmatter: {}, body: normalized, frontmatterLines: [] };
    }
    const marker = "\n---\n";
    const end = normalized.indexOf(marker, 4);
    if (end === -1) {
        return { frontmatter: {}, body: normalized, frontmatterLines: [] };
    }
    const frontmatterLines = normalized.slice(4, end).split("\n");
    const frontmatter: Record<string, any> = {};
    frontmatterLines.forEach((line) => {
        const idx = line.indexOf(":");
        if (idx === -1) return;
        const key = line.slice(0, idx).trim();
        if (!key) return;
        const raw = line.slice(idx + 1).trim();
        frontmatter[key] = parseFrontmatterValue(raw);
    });
    return {
        frontmatter,
        body: normalized.slice(end + marker.length).replace(/^\n/, ""),
        frontmatterLines
    };
}

export function parseFrontmatterValue(raw: string): any {
    if (!raw) return "";

    if (
        raw.startsWith("\"") ||
        raw.startsWith("{") ||
        raw.startsWith("[") ||
        raw === "null" ||
        raw === "true" ||
        raw === "false" ||
        /^-?\d+(\.\d+)?$/.test(raw)
    ) {
        try {
            return JSON.parse(raw);
        } catch (_error) {
        }
    }

    if (raw.startsWith("'") && raw.endsWith("'")) {
        return raw.slice(1, -1).replace(/''/g, "'");
    }

    if (raw === "null") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
}

export function formatFrontmatterValue(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    const normalized = String(value).replace(/\r\n/g, "\n");
    return `'${normalized.replace(/'/g, "''")}'`;
}

/**
 * Render the note file. `preservedFrontmatterLines` should be the raw
 * frontmatter lines from the file being overwritten; keys managed by the
 * plugin (or keys included in `frontmatter`) are dropped from the preserved
 * block to avoid duplicates.
 */
export function renderNoteDocument(
    frontmatter: Record<string, any>,
    body: string,
    preservedFrontmatterLines: string[] = []
): string {
    const managedKeys = new Set<string>([
        ...MANAGED_KEY_SET,
        ...Object.keys(frontmatter)
    ]);
    const lines = ["---"];
    Object.entries(frontmatter).forEach(([key, value]) => {
        lines.push(`${key}: ${formatFrontmatterValue(value)}`);
    });
    lines.push(...collectPreservedFrontmatterLines(preservedFrontmatterLines, managedKeys));
    lines.push("---");
    const normalizedBody = String(body ?? "").replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
    if (!normalizedBody) {
        return `${lines.join("\n")}\n`;
    }
    lines.push(normalizedBody, "");
    return lines.join("\n");
}

function collectPreservedFrontmatterLines(lines: string[], blockedKeys: Set<string>): string[] {
    const kept: string[] = [];
    let currentKey = "";
    let keeping = false;
    for (const line of lines) {
        const match = line.match(FRONTMATTER_KEY_PATTERN);
        if (match) {
            currentKey = match[1].trim();
            keeping = !blockedKeys.has(currentKey);
        } else if (!line.trim()) {
            // Blank separators are only kept inside a preserved block.
            keeping = keeping && kept.length > 0;
        }
        if (keeping) kept.push(line);
    }
    while (kept.length > 0 && !kept[kept.length - 1].trim()) kept.pop();
    return kept;
}
