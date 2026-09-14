import { MessageKey, MessageParams, translateDefault, Translator } from "../i18n";
import { SyncPhase, SyncRunState } from "../types";

export interface SyncRunContext {
    setPhase(phase: SyncPhase, message: string): void;
}

interface SyncRunCoordinatorOptions<TResult> {
    timeoutMs: number;
    createSkippedResult(): TResult;
    createFailureResult(error: unknown): TResult;
    mergeResults(current: TResult, next: TResult): TResult;
    runOnce(context: SyncRunContext): Promise<TResult>;
    onStateChange?(state: SyncRunState): void;
    onTimeout?(error: Error): void;
    translate?: Translator;
}

export class SyncRunCoordinator<TResult> {
    private activePromise: Promise<TResult> | null = null;
    private rerunRequested = false;
    private disposed = false;
    private state: SyncRunState = {
        phase: "idle",
        isRunning: false,
        queued: false,
        startedAt: null,
        finishedAt: null,
        message: this.t("syncRun.notSynced")
    };

    constructor(private options: SyncRunCoordinatorOptions<TResult>) { }

    private t(key: MessageKey, params?: MessageParams): string {
        if (this.options.translate) return this.options.translate(key, params);
        return translateDefault(key, params);
    }

    get isRunning() {
        return this.state.isRunning;
    }

    getState(): SyncRunState {
        return { ...this.state };
    }

    setPhase(phase: SyncPhase, message: string) {
        this.updateState({ phase, message });
    }

    run(): Promise<TResult> {
        if (this.disposed) return Promise.resolve(this.options.createSkippedResult());
        if (this.activePromise) {
            this.rerunRequested = true;
            this.updateState({ phase: "queued", queued: true, message: this.t("syncRun.queuedAfterCurrent") });
            return this.activePromise;
        }

        this.updateState({
            phase: "uploading",
            isRunning: true,
            queued: false,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            message: this.t("syncRun.uploadingLocal")
        });
        const promise = this.runLoop().finally(() => {
            this.activePromise = null;
            this.updateState({
                isRunning: false,
                queued: false,
                finishedAt: new Date().toISOString()
            });
        });
        this.activePromise = promise;
        return promise;
    }

    dispose(message: string = this.t("syncRun.stopped")) {
        this.disposed = true;
        this.rerunRequested = false;
        this.updateState({
            phase: "idle",
            isRunning: false,
            queued: false,
            finishedAt: new Date().toISOString(),
            message
        });
    }

    private async runLoop(): Promise<TResult> {
        let aggregate: TResult | null = null;
        do {
            this.rerunRequested = false;
            let result: TResult;
            try {
                result = await this.withTimeout(
                    this.options.runOnce({ setPhase: (phase, message) => this.setPhase(phase, message) }),
                    this.options.timeoutMs
                );
            } catch (error) {
                const normalized = error instanceof Error ? error : new Error(String(error));
                result = this.options.createFailureResult(normalized);
                this.setPhase("failed", normalized.message);
                if (normalized.name === "SyncRunTimeoutError") this.options.onTimeout?.(normalized);
            }
            aggregate = aggregate === null ? result : this.options.mergeResults(aggregate, result);
        } while (this.rerunRequested && !this.disposed);
        return aggregate ?? this.options.createSkippedResult();
    }

    private async withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                work,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error(this.t("syncRun.timeout", { seconds: Math.round(timeoutMs / 1000) }));
                        error.name = "SyncRunTimeoutError";
                        reject(error);
                    }, timeoutMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private updateState(patch: Partial<SyncRunState>) {
        this.state = { ...this.state, ...patch };
        this.options.onStateChange?.(this.getState());
    }
}
