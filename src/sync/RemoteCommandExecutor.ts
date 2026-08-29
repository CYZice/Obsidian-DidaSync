import { PendingSyncOperation } from "../types";
import { SyncOutbox } from "./SyncOutbox";

export class RemoteCommandExecutor {
    constructor(private outbox: SyncOutbox) { }

    async execute(operation: PendingSyncOperation, command: () => Promise<void>) {
        await this.outbox.markStarted(operation);
        try {
            await command();
            if (this.outbox.list().includes(operation)) await this.outbox.remove(operation);
        } catch (error) {
            await this.outbox.markFailed(operation, error);
            throw error;
        }
    }
}
