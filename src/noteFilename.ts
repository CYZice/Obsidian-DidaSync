/**
 * Pure helpers for mapping Dida note titles to Obsidian file names.
 *
 * Kept free of Obsidian imports so they can be unit tested without a vault mock.
 */

/** Fixed fallback used when a Dida note has a blank title. */
export const UNTITLED_NOTE_STEM = "未命名";

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_STEM_LENGTH = 100;

/**
 * Normalize a Dida note title into a safe Obsidian file-name stem.
 *
 * The result intentionally keeps the title text as close as possible, because
 * the file name doubles as a directory entry the user reads and edits.
 */
export function sanitizeNoteFilenameStem(raw: string | null | undefined): string {
    const value = typeof raw === "string" ? raw : "";
    let sanitized = value
        .replace(/\r\n/g, "\n")
        .replace(/[\r\n\t]+/g, " ")
        .replace(CONTROL_CHARS, " ")
        .replace(ILLEGAL_FILENAME_CHARS, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/g, "")
        .slice(0, MAX_STEM_LENGTH)
        .trim()
        .replace(/[. ]+$/g, "");
    if (WINDOWS_RESERVED_NAME.test(sanitized)) {
        sanitized = sanitized.replace(
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i,
            (_match, base: string, extension: string = "") => `${base}_${extension}`
        );
    }
    return sanitized || UNTITLED_NOTE_STEM;
}

/** Build the ` (1)`, ` (2)` conflict stems used when a plain title is taken. */
export function buildConflictStem(base: string, index: number): string {
    const stem = base || UNTITLED_NOTE_STEM;
    return index <= 0 ? stem : `${stem} (${index})`;
}

/** True when a remote title would map to the same file name stem. */
export function sameNoteStem(a: string | null | undefined, b: string | null | undefined): boolean {
    return sanitizeNoteFilenameStem(a) === sanitizeNoteFilenameStem(b);
}

function findLeadingTitleHeadingLine(lines: string[], candidates: string[]): number {
    const wanted = candidates
        .map((value) => (value || "").trim())
        .filter(Boolean);
    if (wanted.length === 0) return -1;
    const firstIndex = lines.findIndex((line) => line.trim().length > 0);
    if (firstIndex === -1) return -1;
    const match = lines[firstIndex].match(/^##(?!#)\s+(.*)$/);
    if (!match) return -1;
    const headingText = match[1].trim();
    return wanted.includes(headingText) ? firstIndex : -1;
}

/**
 * Remove the legacy `## 标题` first line that older DidaSync versions wrote
 * into the note body. Only the first heading is removed, and only when it
 * exactly matches one of the candidate titles.
 */
export function stripLeadingTitleHeading(body: string, candidates: string[]): string {
    const normalized = String(body || "").replace(/\r\n/g, "\n").replace(/^\n+/, "");
    const lines = normalized.split("\n");
    const headingIndex = findLeadingTitleHeadingLine(lines, candidates);
    if (headingIndex === -1) return normalized.trimEnd();
    const rest = lines.slice(headingIndex + 1);
    while (rest.length > 0 && rest[0].trim() === "") rest.shift();
    return rest.join("\n").trimEnd();
}

/** True when `body` starts with the legacy `## 标题` heading (migration hint). */
export function hasLeadingTitleHeading(body: string, candidates: string[]): boolean {
    const lines = String(body || "").replace(/\r\n/g, "\n").replace(/^\n+/, "").split("\n");
    return findLeadingTitleHeadingLine(lines, candidates) !== -1;
}
