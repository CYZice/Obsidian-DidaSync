# DidaSync User Guide

## Get started

1. Open **Settings → DidaSync → OAuth** and authorize your Dida365 or TickTick account.
2. Open the DidaSync sidebar from the ribbon or run **Open DidaSync**.
3. Run **Sync tasks now** once to load your tasks.

Enable automatic sync under **Settings → DidaSync → Sync** for daily use.

## Manage tasks

The sidebar lets you create, edit, complete, reorder, and move tasks between projects. Drag a task under another task to make it a subtask. Dates, reminders, priorities, and repeat rules are synchronized in both directions.

## Native Obsidian tasks

Enable **Native task sync** under Sync settings. Use a normal `- [ ]` task in Markdown, then run **Insert/create Dida task** to create or link it. Checking the task later updates the remote task.

When **Create subtasks from indentation** is enabled, indented checkboxes become subtasks of the nearest preceding checkbox with less indentation and inherit the parent's project. Sync or link each parent before creating its children; if the parent has no Dida link yet, or the child explicitly names a different project, DidaSync stops instead of creating an inconsistent task.

## Write tasks to notes

Run **Sync tasks to note** and choose a day, week, month, year, or custom range. Select the project scope and destination folder. DidaSync writes a Markdown summary using the configured block and path patterns.

## Sync Dida notes

Enable **Dida note sync**, select projects, and choose a destination folder. Run **Sync Dida notes to Obsidian**. Each remote NOTE is stored as a Markdown file that can be edited locally and synchronized again.

## Calendar, time blocks, and Pomodoro

Use the view controls at the top of the sidebar to switch between the task list, time-block schedule, timeline calendar, and Pomodoro focus mode. Calendar views can include completed tasks for review.

## MCP / AI integration

Desktop users can enable the local MCP server under **Settings → DidaSync → MCP**. Copy the generated token into an MCP-compatible AI client. Start with read-only mode, then enable write operations only when needed.

## Troubleshooting

- Re-authorize if the OAuth token has expired.
- Run a manual sync after restoring network connectivity.
- Use **Settings → DidaSync → Advanced → Reset task data** only when you need to rebuild the local cache from the cloud.
- Set **UI language** under **Settings → DidaSync → Views** to Auto, English, or Simplified Chinese. Changes apply after reloading the plugin.
