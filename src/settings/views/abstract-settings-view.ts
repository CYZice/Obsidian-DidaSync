import { App } from "obsidian";
import DidaSyncPlugin from "../../main";

export abstract class AbstractSettingsView {
    constructor(protected app: App, protected plugin: DidaSyncPlugin) {}
    abstract render(containerEl: HTMLElement): void;
}
