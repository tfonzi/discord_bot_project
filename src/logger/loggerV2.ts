import pino, { Logger as PinoLogger, DestinationStream, Bindings } from 'pino';

const FILE_PATH = "./logs/bot.log";

// Log levels compatible with the previous setup
type LogLevel = "DEBUG" | "INFO" | "VERBOSE";

export function isLogLevel(a: string): a is LogLevel {
    return ["DEBUG", "INFO", "VERBOSE"].includes(a);
}

// Map our levels to Pino levels
const levelMapping: { [key in LogLevel]: string } = {
    VERBOSE: 'trace',
    DEBUG: 'debug',
    INFO: 'info'
};

export class LoggerV2 {
    private static instance: PinoLogger | undefined;

    // Private constructor to prevent direct instantiation
    private constructor() {}

    /**
     * Creates and initializes the singleton Pino logger instance.
     * Configures transports for console (pretty-printed) and file.
     * Throws error if called again when an instance already exists.
     * @param logLevel The minimum log level ('DEBUG', 'INFO', 'VERBOSE').
     * @returns The created Pino Logger instance.
     */
    public static createLogger(logLevel: LogLevel): PinoLogger {
        if (LoggerV2.instance) {
            // Optionally return existing instance or throw, decided to throw for clarity
            throw new Error("LoggerV2 instance already created. Use getLogger() or ensure createLogger is called only once.");
        }

        const pinoLevel = levelMapping[logLevel] || 'info'; // Default to 'info' if invalid level provided

        const targets: pino.TransportTargetOptions[] = [
            // File target
            {
                target: 'pino/file', // Use built-in file transport
                level: pinoLevel,
                options: {
                    destination: FILE_PATH,
                    mkdir: true, // Create log directory if it doesn't exist
                    append: true // Append to existing file
                }
            }
        ];

        // Console target (pretty-printed, potentially only for development)
        // Check an environment variable like NODE_ENV
        if (process.env.NODE_ENV !== 'production') {
            targets.push({
                target: 'pino-pretty',
                level: pinoLevel,
                options: {
                    colorize: true,
                    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l', // More readable timestamp
                    ignore: 'pid,hostname' // Optional: Hide pid and hostname
                }
            });
        } else {
             // Basic console logging for production if needed, or rely solely on file
             targets.push({
                 target: 'pino/file', // Log JSON to stdout in production
                 level: pinoLevel,
                 options: { destination: 1 } // 1 = stdout
             });
        }

        LoggerV2.instance = pino({
            level: pinoLevel,
            transport: {
                targets: targets
            }
        });

        LoggerV2.instance.info(`LoggerV2 initialized with level: ${logLevel} (Pino: ${pinoLevel})`);

        return LoggerV2.instance;
    }

    /**
     * Gets the singleton Pino logger instance.
     * Throws error if the logger hasn't been created yet.
     * @returns The Pino Logger instance.
     */
    public static getLogger(): PinoLogger {
        if (!LoggerV2.instance) {
            throw new Error("LoggerV2 instance not created. Call createLogger() first.");
        }
        return LoggerV2.instance;
    }

    /**
     * Creates a child logger with the specified bindings.
     * Child loggers inherit the parent's level and transports but add contextual info.
     * Throws error if the base logger hasn't been created yet.
     * @param bindings An object containing properties to add to log output (e.g., { channelId: '123' }).
     * @returns A new Pino child logger instance.
     */
    public static getChildLogger(bindings: Bindings): PinoLogger {
         const parentLogger = LoggerV2.getLogger(); // Throws if not created
         return parentLogger.child(bindings);
    }

    /**
     * Placeholder for closing/flushing logic if needed.
     * Pino generally handles stream cleanup. Explicit flushing might require process exit hooks.
     * Example exit hook: process.on('beforeExit', () => { LoggerV2.getLogger()?.flush(); });
     */
    public static closeLogger(): void {
        // No explicit stream closing needed for pino's managed transports.
        // Explicit flushing can be done via logger.flush() in process exit handlers if needed.
        LoggerV2.instance?.info('closeLogger called (typically a no-op for managed pino transports).');
    }
} 