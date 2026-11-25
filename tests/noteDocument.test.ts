import assert from "node:assert/strict";
import { formatFrontmatterValue, parseFrontmatterValue, parseNoteFile, renderNoteDocument } from "../src/noteDocument";

const plain = parseNoteFile("just body\n");
assert.deepEqual(plain.frontmatter, {});
assert.equal(plain.body, "just body\n");
assert.deepEqual(plain.frontmatterLines, []);

const legacy = parseNoteFile([
    "---",
    "didaNoteId: 'note-1'",
    "didaNoteKind: 'NOTE'",
    "didaNoteSyncStatus: 'synced'",
    "didaEtag: 'e1'",
    "didaModifiedTime: '2026-11-25T11:04:17.000+0000'",
    "didaLastSyncedContentHash: 'd6c8e73f'",
    "didaLastSyncedAt: '2026-11-25T11:04:30.372Z'",
    "tags:",
    "  - dida",
    "custom: 'x'",
    "---",
    "",
    "## Test",
    "",
    "123",
    ""
].join("\n"));
assert.equal(legacy.frontmatter.didaNoteId, "note-1");
assert.equal(legacy.frontmatter.didaNoteSyncStatus, "synced");
assert.equal(legacy.frontmatter.tags, "");
assert.equal(legacy.frontmatter.custom, "x");
assert.equal(legacy.body, "## Test\n\n123\n");
assert.deepEqual(legacy.frontmatterLines.slice(0, 2), ["didaNoteId: 'note-1'", "didaNoteKind: 'NOTE'"]);

const rendered = renderNoteDocument(
    {
        didaNoteId: "note-1",
        didaNoteKind: "NOTE",
        didaNoteSyncStatus: "synced",
        didaEtag: "",
        didaModifiedTime: "",
        didaLastSyncedContentHash: "hash",
        didaLastSyncedAt: "now"
    },
    "## Test\n\n123",
    legacy.frontmatterLines
);
assert.equal((rendered.match(/didaNoteId:/g) || []).length, 1, "managed keys must not be duplicated");
assert.equal((rendered.match(/didaNoteKind:/g) || []).length, 1);
assert.match(rendered, /tags:\n {2}- dida/);
assert.match(rendered, /custom: 'x'/);
assert.match(rendered, /\n---\n## Test\n\n123\n$/);

const emptyBody = renderNoteDocument({ didaNoteId: "n" }, "");
assert.equal(emptyBody, "---\ndidaNoteId: 'n'\n---\n");

assert.equal(formatFrontmatterValue("a'b"), "'a''b'");
assert.equal(formatFrontmatterValue(3), "3");
assert.equal(formatFrontmatterValue(true), "true");
assert.equal(formatFrontmatterValue(null), "null");

assert.equal(parseFrontmatterValue("'x'"), "x");
assert.equal(parseFrontmatterValue("42"), 42);
assert.equal(parseFrontmatterValue("true"), true);
assert.equal(parseFrontmatterValue("null"), null);
assert.equal(parseFrontmatterValue("plain text"), "plain text");

const malformed = parseNoteFile("---\nno closing fence\n");
assert.equal(malformed.body, "---\nno closing fence\n");

console.log("noteDocument tests passed");
