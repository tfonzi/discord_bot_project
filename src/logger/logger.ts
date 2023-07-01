import { WriteStream, createWriteStream } from "fs";
import { serializeError } from "serialize-error";

const FILE_PATH = "./logs/bot.log"

type LogLevel = "DEBUG" | "INFO" | "VERBOSE"

export function isLogLevel(a: string): a is LogLevel {
    return ((a as LogLevel) === "DEBUG") || ((a as LogLevel) === "INFO") || ((a as LogLevel) === "VERBOSE");
}

export interface Logger {
    createLogger(logLevel: LogLevel): Logger;
    getLogger(): Logger;
    closeLogger(): void;
   
}

export class Logger implements Logger {

    static instance: Logger | undefined;
    logStream: WriteStream;

    constructor(private logLevel: LogLevel) {
        this.logStream = createWriteStream(FILE_PATH, { flags: "a"})
    }

    log(text: string) {
        const formatted = `${(new Date(Date.now())).toISOString()} [Info] ${text} \n`
        this.logStream.write(formatted);
        console.log(formatted);
    }

    debug(text: string) {
        if (this.logLevel == "DEBUG" || this.logLevel == "VERBOSE") {
            const formatted = `${(new Date(Date.now())).toISOString()} [Debug] ${text} \n`
            this.logStream.write(formatted);
            console.debug(formatted);
        }
    }

    verbose(text: string) {
        if (this.logLevel == "VERBOSE") {
            const formatted = `${(new Date(Date.now())).toISOString()} [Verbose] ${text} \n`
            this.logStream.write(formatted);
            console.debug(formatted);
        }
    }

    error(error: Error) {
        const formatted = `${(new Date(Date.now())).toISOString()} [Error] ${JSON.stringify(serializeError(error), null, 2)} \n`
        this.logStream.write(formatted);
        console.error(formatted);
    }

    static createLogger(logLevel: LogLevel): Logger {
        if (!Logger.instance){
            Logger.instance = new Logger(logLevel);
        }
        return Logger.instance;
    }

    static getLogger(): Logger {
        if (!Logger.instance){
            throw new Error("Logger does not exist. Create one first.");
        }
        return Logger.instance;
    }

    static closeLogger(): void {
        if (Logger.instance){
            Logger.instance.logStream.close();
            Logger.instance = undefined;
        }
    }
}