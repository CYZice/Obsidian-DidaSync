# Dida note title ⇄ file name sync

This page describes the note sync changes in this branch: a new optional setting, **Sync note title to file name**, and a fix for the case where renaming a synced note file was treated as a deletion.

## Background: two defects

1. **Rename = delete.** Sync records stored the old path of each note file. After a rename the old path no longer resolved, so `LocalDeletionTracker` reported the file as deleted and asked for confirmation; confirming also deleted the remote note.
2. **Remote title changes did not rename the local file.** File names were built as `Title-<last 6 chars of id>.md` and the body repeated the title as a `##` heading. After a title change on the Dida side the next sync updated only the heading line, leaving the file name stale.

Root cause: locating a local file relied on the stored path and on the file name, instead of on the `didaNoteId` the note carries itself.

## Setting: Settings → DidaSync → Sync → Dida note sync

**Sync note title to file name** (`didaNoteSyncTitleToFilename`, off by default)

When enabled:

| Item | Behavior |
|---|---|
| File name | Only the sanitized Dida title, e.g. `test.md`; the `-5213ea` id suffix is dropped |
| Body | No `## title` line is written; the file body is the note body |
| Title matching | Title = file name; body content maps to the remote `content` field |
| Dida title change | The next sync renames the file through `app.fileManager.renameFile()`; `[[wikilinks]]` are maintained by Obsidian |
| Obsidian rename | After a 1.5 s debounce a notes-only sync runs and pushes the new file name as the remote title |
| Untitled note | A remote empty title maps to `未命名.md` |
| Duplicate names | Falls back to `Title (1).md`, `Title (2).md`, … |
| Existing notes | The first sync after enabling the setting tidies them up: id suffix removed, heading line removed; notes whose content already matches the remote do not cause a remote write |

With the setting off, the 1.9.1 layout is preserved (id suffix, `## title` heading), but **a rename is no longer reported as a deletion**.

## Matching

- Every synced file carries `didaNoteId` in its frontmatter; that is its only identity.
- `NoteFileLocator` walks the note folder once per sync and prefers the frontmatter from Obsidian's `metadataCache`. File content is read only when the cache has no entry (for example a file created moments ago), so the vault is never scanned line by line.
- Sync records gained two fields:
  - `localFileStem`: the file name stem confirmed during the previous sync (including a conflict suffix), used to detect a rename;
  - `contentFormat`: `plain` (new layout) or `heading` (legacy layout), used for a one-off migration.

## Decision order of one sync (setting enabled)

1. Resolve the local file by `didaNoteId`: first the recorded path, then a lookup by id inside the note folder. Only a missing file counts as a deletion.
2. Migrate legacy records: strip the leading `## title` line, then compare with the remote body:
   - equal: normalize the file only, never write the remote;
   - different and the remote did not change: treat as a local edit and push the body;
   - different on both sides: compare modification times; the winner decides body and title.
3. Records in the new layout: check local body, local file name, remote body, and remote title independently:
   - only local changed: push body and title;
   - only remote changed: write the body and rename when needed;
   - both changed: reuse the existing whole-entity conflict policy (when timestamps are comparable the winner decides content and title);
   - nothing changed: no file write, no API call.

## Loop prevention

1. Before renaming a file itself, the plugin records the target path; a matching `vault.on("rename")` event is ignored and does not start a sync.
2. The sync record is updated immediately with the new `path`, `localFileStem`, and `title`, so the next sync finds no difference and does not push again.
3. Files are written and API calls made only when a real difference is detected; a settled vault syncs idempotently.
4. Rapid renames are merged by the 1.5 s debounce; if a sync is already running the work is left to the next automatic sync.
5. A normal file deletion still goes through the existing deletion-candidate confirmation, so the remote note is never removed by accident.

## Migration and frontmatter

- After the setting is enabled, existing notes are tidied up on the next sync. The migration only changes local files; the remote is untouched unless the local body was genuinely edited.
- When writing a file back, only the seven `dida*` frontmatter keys are replaced. Frontmatter added by the user or by other plugins (for example `tags`) is preserved as-is.
- Turning the setting off and on again is safe: the legacy layout is detected and migrated again, and a `##` line at the top of the user's own body is not removed.
- Records keep the raw remote title; an empty title falls back to displaying the path in the UI.

## Known limitations

- When two notes swap titles, processing them in order can temporarily leave a ` (1)` suffix (no file is lost and it can be renamed by hand).
- Once the conflict is gone, `Title (1).md` is not moved back to `Title.md` automatically.
- In a whole-entity conflict the content winner also decides the title: a local win keeps the local file name and pushes it, a remote win adopts the remote title and renames.
- A rename made outside Obsidian (in the file system) can surface as a delete plus a create; the rename event may not fire. The `didaNoteId` lookup then heals the record on the next sync (at the latest after one automatic sync cycle).
- `未命名` is a fixed Chinese fallback and does not follow the UI language.

## Files involved

- `src/noteFilename.ts`: file name sanitizing, conflict stems, legacy title-stripping helpers.
- `src/noteDocument.ts`: frontmatter and body parsing/rendering, preserving user frontmatter.
- `src/sync/NoteFileLocator.ts`: `metadataCache`-based `didaNoteId` index.
- `src/managers/NoteSyncManager.ts`: dual-format sync, migration, rename handling, loop prevention.
- `src/sync/LocalDeletionTracker.ts`: heals renamed notes by `didaNoteId` instead of reporting a deletion.
- `src/main.ts`: registers `vault.on("rename")` and schedules a debounced note sync.
- `src/settings/views/sync-settings-view.ts`, `src/i18n.ts`: setting UI and strings (English and Simplified Chinese).
- `tests/noteFilename.test.ts`, `tests/noteDocument.test.ts`, `tests/noteSyncManager.test.ts`: sanitizing, parsing, migration, bidirectional renames, conflict names, empty titles, loop prevention, and self-healing.

## Tests and build

```bash
npm ci
npm test
npm run build
```

## Manual verification

The behavior was checked against a live Dida account:

- Enabling the setting with 11 existing notes: all 11 files lost the id suffix and the heading line, `tags` frontmatter on 4 files survived, nothing was pushed, and no deletion candidates appeared.
- Dida title change (`test` → `test-renamed`): the file was renamed on the next sync, the record and etag followed, and no copy was left behind.
- Obsidian rename (`test-renamed` → `test-obsidian`): the remote title followed within about three seconds, the body was unchanged, and the etag was still identical ten seconds later, so no sync loop occurred.
- Duplicate title: a title matching an existing note produced `星月夜 (1).md` while the original file was kept.
- Empty title: a cleared remote title produced `未命名.md` and the record stored an empty title.
