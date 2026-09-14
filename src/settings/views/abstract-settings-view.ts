import { App } from "obsidian";
import DidaSyncPlugin from "../../main";
import { MessageKey, MessageParams } from "../../i18n";

export abstract class AbstractSettingsView {
    constructor(protected app: App, protected plugin: DidaSyncPlugin) {}
    abstract render(containerEl: HTMLElement): void;

    /** Translate a plugin-owned UI string using the current UI language. */
    protected t(key: MessageKey, params?: MessageParams): string {
        return this.plugin.t(key, params);
    }
}
