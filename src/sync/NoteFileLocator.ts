import { App, TFile, normalizePath } from "obsidian";
import { parseNoteFile } from "../noteDocument";

export interface NoteFileHit {
    file: TFile;
    frontmatter: Record<string, any>;
}

/** Files larger than this are never read as a frontmatter fallback. */
const FRONTMATTER_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Folder-scoped lookup of synced note files by `didaNoteId`.
 *
 * Obsidian's metadata cache already parses frontmatter, so a whole-folder scan
 * is cheap: the index is built once per sync run from cached metadata, and only
 * files whose cache is missing (freshly created, not indexed yet) fall back to
 * a single content read.
 */
export class NoteFileLocator {
    private index: Map<string, NoteFileHit[]> | null = null;

    constructor(private app: App, private getNoteFolder: () => string) { }

    /** Start a logical sync run: the next index build reflects the vault now. */
    begin(): void {
        this.index = null;
    }

    /** Finish a logical sync run so the next run re-reads the vault. */
    end(): void {
        this.index = null;
    }

    invalidate(): void {
        this.index = null;
    }

    listNoteFolderMarkdownFiles(): TFile[] {
        const getMarkdownFiles = (this.app.vault as any)?.getMarkdownFiles;
        if (typeof getMarkdownFiles !== "function") return [];
        const files = getMarkdownFiles.call(this.app.vault);
        if (!Array.isArray(files)) return [];

        const root = normalizePath((this.getNoteFolder() || "").trim());
        if (!root) {
            return files.filter((file: unknown) => file instanceof TFile && !file.path.includes("/"));
        }

        const prefix = `${root}/`;
        return files.filter((file: unknown) => file instanceof TFile && file.path.startsWith(prefix));
    }

    getCachedFrontmatter(file: TFile): Record<string, any> | null {
        const cache = (this.app.metadataCache as any)?.getFileCache?.(file);
        if (cache?.frontmatter && typeof cache.frontmatter === "object") {
            return cache.frontmatter as Record<string, any>;
        }
        return null;
    }

    async getFileFrontmatter(file: TFile): Promise<Record<string, any>> {
        const cached = this.getCachedFrontmatter(file);
        if (cached) return cached;
        return this.readFrontmatter(file);
    }

    private async readFrontmatter(file: TFile): Promise<Record<string, any>> {
        try {
            const size = (file as any)?.stat?.size;
            if (typeof size === "number" && size > FRONTMATTER_FALLBACK_MAX_BYTES) return {};
            const vault = this.app.vault as any;
            const read = typeof vault.cachedRead === "function" ? vault.cachedRead.bind(vault) : vault.read.bind(vault);
            const content = await read(file);
            return parseNoteFile(content).frontmatter;
        } catch (_error) {
            return {};
        }
    }

    async buildIndex(): Promise<Map<string, NoteFileHit[]>> {
        if (this.index) return this.index;
        const index = new Map<string, NoteFileHit[]>();
        for (const file of this.listNoteFolderMarkdownFiles()) {
            let frontmatter = this.getCachedFrontmatter(file);
            if (!frontmatter) frontmatter = await this.readFrontmatter(file);
            const didaId = typeof frontmatter?.didaNoteId === "string" ? frontmatter.didaNoteId.trim() : "";
            if (!didaId) continue;
            const hits = index.get(didaId) || [];
            hits.push({ file, frontmatter });
            index.set(didaId, hits);
        }
        this.index = index;
        return index;
    }

    async find(didaId: string): Promise<NoteFileHit[]> {
        const id = (didaId || "").trim();
        if (!id) return [];
        const index = await this.buildIndex();
        return index.get(id) || [];
    }
}
