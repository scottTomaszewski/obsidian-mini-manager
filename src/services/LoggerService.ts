import { App, normalizePath } from 'obsidian';

export enum LogLevel {
    DEBUG,
    INFO,
    WARN,
    ERROR,
}

export class LoggerService {
    private app: App;
    private logFilePath: string;

    constructor(app: App, pluginDir: string) {
        this.app = app;
        this.logFilePath = normalizePath(`${pluginDir}/debug.log`);
    }

    private async writeLog(level: LogLevel, message: string) {
        const timestamp = new Date().toISOString();
        const levelStr = LogLevel[level];
        const logMessage = `${timestamp} [${levelStr}] ${message}
`;

        try {
            await this.app.vault.adapter.append(this.logFilePath, logMessage);
        } catch (error) {
            console.error("Failed to write to log file:", error);
        }
    }

    public debug(message: string) {
        this.writeLog(LogLevel.DEBUG, message);
    }

    public info(message: string) {
        this.writeLog(LogLevel.INFO, message);
    }

    public warn(message: string) {
        this.writeLog(LogLevel.WARN, message);
    }

    public error(message: string) {
        console.error(message);
        this.writeLog(LogLevel.ERROR, message);
    }
}
