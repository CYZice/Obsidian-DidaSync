import assert from "node:assert/strict";
import {
    UNTITLED_NOTE_STEM,
    buildConflictStem,
    hasLeadingTitleHeading,
    sameNoteStem,
    sanitizeNoteFilenameStem,
    stripLeadingTitleHeading
} from "../src/noteFilename";

assert.equal(sanitizeNoteFilenameStem("test"), "test");
assert.equal(sanitizeNoteFilenameStem("  空白  标题  "), "空白 标题");
assert.equal(sanitizeNoteFilenameStem("a/b:c*d?e\"f<g>h|i#j^k[l]m"), "a b c d e f g h i j k l m");
assert.equal(sanitizeNoteFilenameStem(""), UNTITLED_NOTE_STEM);
assert.equal(sanitizeNoteFilenameStem("   "), UNTITLED_NOTE_STEM);
assert.equal(sanitizeNoteFilenameStem("..."), UNTITLED_NOTE_STEM);
assert.equal(sanitizeNoteFilenameStem("标题. "), "标题");
assert.equal(sanitizeNoteFilenameStem("CON"), "CON_");
assert.equal(sanitizeNoteFilenameStem("con"), "con_");
assert.equal(sanitizeNoteFilenameStem("con.txt"), "con_.txt");
assert.equal(sanitizeNoteFilenameStem("a".repeat(200)).length, 100);
assert.equal(sanitizeNoteFilenameStem("多\n行\t标题"), "多 行 标题");

assert.equal(buildConflictStem("x", 0), "x");
assert.equal(buildConflictStem("x", 2), "x (2)");
assert.equal(buildConflictStem("", 1), `${UNTITLED_NOTE_STEM} (1)`);

assert.equal(sameNoteStem("a/b", "a b"), true);
assert.equal(sameNoteStem("a/b", "ab"), false);

assert.equal(stripLeadingTitleHeading("## T\n\nbody", ["T"]), "body");
assert.equal(stripLeadingTitleHeading("\n\n## T\nbody", ["T"]), "body");
assert.equal(stripLeadingTitleHeading("## Other\n\nbody", ["T"]), "## Other\n\nbody");
assert.equal(stripLeadingTitleHeading("## T\n\n## T\n\nbody", ["T"]), "## T\n\nbody");
assert.equal(stripLeadingTitleHeading("body", ["T"]), "body");
assert.equal(stripLeadingTitleHeading("### T\nbody", ["T"]), "### T\nbody");
assert.equal(stripLeadingTitleHeading("## T\n\nbody", []), "## T\n\nbody");

assert.equal(hasLeadingTitleHeading("## T\n", ["T"]), true);
assert.equal(hasLeadingTitleHeading("### T\n", ["T"]), false);
assert.equal(hasLeadingTitleHeading("body", ["T"]), false);

console.log("noteFilename tests passed");
