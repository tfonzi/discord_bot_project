import { RedisClientType, SchemaFieldTypes, VectorAlgorithms, createClient } from "redis";
import { LoggerV2 } from "../logger/loggerV2"; // Use LoggerV2
import { Logger as PinoLogger, Bindings } from 'pino'; // Import PinoLogger type

// Helper function remains the same
function float32Buffer(arr: number[]) {
    return Buffer.from(new Float32Array(arr).buffer);
}

// Interfaces remain the same
export interface embeddingData {
    text: string,
    embedding: number[]
}
export interface Memory {
    memory: string,
    redisKey: string
}
export interface VectorSimilarityResult {
    result: string,
    similarity: number
}

// No RedisEmbeddingService interface needed if class defines it directly

export class RedisEmbeddingServiceV2 { // Renamed class

    private static instance: RedisClientType;
    // Map to store child loggers
    private static redisLoggers: Map<string, PinoLogger> = new Map();

    // Private constructor to prevent direct instantiation
    private constructor() { }

    // Helper to get/create Redis-specific child logger based on indexName
    private static _getOrCreateRedisLogger(indexName?: string): PinoLogger {
        const baseBindings = { component: 'Redis' };
        let finalBindings: Bindings;
        let loggerKey: string;

        if (indexName) {
            finalBindings = { ...baseBindings, indexName };
            loggerKey = `redis-${indexName}`;
        } else {
            finalBindings = { ...baseBindings };
            loggerKey = 'redis-base';
        }

        if (RedisEmbeddingServiceV2.redisLoggers.has(loggerKey)) {
            return RedisEmbeddingServiceV2.redisLoggers.get(loggerKey)!;
        }

        const baseLogger = LoggerV2.getLogger();
        const childLogger = baseLogger.child(finalBindings);
        RedisEmbeddingServiceV2.redisLoggers.set(loggerKey, childLogger);
        childLogger.trace({ bindings: finalBindings }, 'Created Redis child logger');
        return childLogger;
    }

    // Private helper for index existence check (no logger needed here directly)
    private static async _indexExists(indexName: string): Promise<boolean> {
        if (!RedisEmbeddingServiceV2.instance) {
            throw new Error("Cannot check index info: No client exists");
        }
        return RedisEmbeddingServiceV2.instance.ft.info(`idx:${indexName}`).then(() => true, () => false);
    }

    public static async CreateClient(password: string): Promise<void> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger();
        if (RedisEmbeddingServiceV2.instance) {
             logger.warn('Redis client already created. Ignoring call.');
             return;
        }
        try {
            logger.info('Creating and connecting Redis client...');
            RedisEmbeddingServiceV2.instance = createClient({
                url: `redis://redis:6379`, // Consider making URL configurable
                password: password
            });
            await RedisEmbeddingServiceV2.instance.connect();
            logger.info('Redis client connected successfully.');
        } catch(error) {
            logger.error({ err: error }, 'Failed to create or connect Redis client');
            RedisEmbeddingServiceV2.instance = undefined; // Ensure instance is cleared on failure
            throw error;
        }
    }

    public static async DeleteClient(): Promise<void> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger();
        if (!RedisEmbeddingServiceV2.instance) {
            logger.warn("Cannot delete client: No client exists.");
            return;
        }
        try {
            logger.info('Disconnecting Redis client...');
            await RedisEmbeddingServiceV2.instance.disconnect();
            logger.info('Redis client disconnected.');
        } catch(error) {
            logger.error({ err: error }, 'Error disconnecting Redis client');
            // Still clear instance even if disconnect fails?
            // throw error; // Rethrow?
        } finally {
             RedisEmbeddingServiceV2.instance = undefined;
             RedisEmbeddingServiceV2.redisLoggers.clear(); // Clear loggers on disconnect
        }
    }

    public static async GetClient(): Promise<RedisClientType> {
        if (!RedisEmbeddingServiceV2.instance) {
            // Maybe log warning/error before throwing?
            throw new Error("Cannot get client: No client exists or not connected. Call CreateClient first.");
        }
        return RedisEmbeddingServiceV2.instance;
    }

    public static async CreateIndexForEmbedding(indexName: string): Promise<void> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger(indexName);
        if (!RedisEmbeddingServiceV2.instance) {
            throw new Error("Cannot create index: No connected client exists");
        }
        logger.info('Attempting to create Redis vector index...');
        try {
            // Define schema using the correct format
            const schema = {
                '$.embedding': {
                     type: SchemaFieldTypes.VECTOR,
                     AS: 'embedding',
                     ALGORITHM: VectorAlgorithms.HNSW,
                     TYPE: 'FLOAT32',
                     DIM: 1536,
                     DISTANCE_METRIC: 'COSINE'
                 },
                // Optionally add text field for storage
                 '$.text': {
                     type: SchemaFieldTypes.TEXT,
                     AS: 'text'
                 }
            };

            // Correct call signature: (indexName, schema, options)
            await RedisEmbeddingServiceV2.instance.ft.create(
                `idx:${indexName}`,
                schema as any, // Use 'as any' to bypass potential complex type mismatch for now
                {
                    ON: 'JSON',
                    PREFIX: `noderedis:${indexName}:`
                }
            );
            logger.info(`Successfully created/verified Redis index 'idx:${indexName}' for JSON documents`);
        } catch (e) {
            if (e instanceof Error && e.message === 'Index already exists') {
                logger.info(`Index 'idx:${indexName}' already exists.`);
            } else {
                logger.error({ err: e }, `Failed to create index 'idx:${indexName}'`);
                throw e;
            }
        }
    }

    public static async SetEmbeddingData(indexName: string, value: embeddingData): Promise<void> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger(indexName);
        if (!RedisEmbeddingServiceV2.instance) {
            throw new Error("Cannot set data: No connected client exists");
        }

        // Validate index exists before attempting to set data
        if (!(await RedisEmbeddingServiceV2._indexExists(indexName))) {
             logger.error(`Index 'idx:${indexName}' does not exist. Cannot set data.`);
             throw new Error(`Cannot set data: Index 'idx:${indexName}' does not exist.`);
        }

        const redisKey = `noderedis:${indexName}:${value.text}`; // Key format
        logger.debug({ redisKey: redisKey.substring(0, 30) + '...' }, 'Setting embedding data');
        try {
            // Use JSON.set for compatibility with JSON index type
            // Store the text alongside the embedding in a JSON object
            await RedisEmbeddingServiceV2.instance.json.set(redisKey, '.', {
                 embedding: value.embedding,
                 text: value.text // Store original text if needed
            });
            logger.info({ redisKey }, `Successfully set embedding data using JSON`);
        } catch(err) {
             logger.error({ err, redisKey }, 'Failed to set embedding data using JSON');
             throw err;
        }
    }

    public static async DeleteKey(key: string): Promise<void> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger(); // Use base redis logger
        if (!RedisEmbeddingServiceV2.instance) {
            throw new Error("Cannot delete key: No connected client exists");
        }
        logger.debug({ key }, 'Deleting key');
        try {
             const result = await RedisEmbeddingServiceV2.instance.del(key);
             if (result > 0) {
                 logger.info({ key }, `Successfully deleted key`);
             } else {
                  logger.warn({ key }, `Key not found or already deleted`);
             }
        } catch (err) {
            logger.error({ err, key }, 'Failed to delete key');
            throw err;
        }
    }

    public static async PerformVectorSimilarity(indexName: string, embedding: number[], k: number = 10): Promise<VectorSimilarityResult[]> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger(indexName);
        if (!RedisEmbeddingServiceV2.instance) {
            throw new Error("Cannot perform search: No connected client exists");
        }
        logger.debug({ k }, 'Performing vector similarity search');
        try {
            // Query needs to change slightly for JSON index
            const query = `*=>[KNN ${k} @embedding $BLOB AS dist]`;
            const results = await RedisEmbeddingServiceV2.instance.ft.search(
                `idx:${indexName}`,
                query,
                {
                    PARAMS: {
                        BLOB: float32Buffer(embedding)
                    },
                    SORTBY: 'dist',
                    DIALECT: 2,
                    RETURN: ['$.text', 'dist'] // Request text and distance
                }
            );

            logger.info({ count: results.total }, `Found ${results.total} potential matches`);

            const mappedResults = results.documents.map((doc): VectorSimilarityResult => {
                // Extract text directly from the returned value object
                return {
                    result: doc.value?.text as string || doc.id, // Fallback to ID if text isn't stored/returned
                    similarity: parseFloat(doc.value.dist as string)
                };
            });

            logger.debug({ results: mappedResults.slice(0, 3) }, `Top ${Math.min(3, mappedResults.length)} vector search results`);
            return mappedResults;
        } catch (err) {
            logger.error({ err, k }, 'Failed to perform vector similarity search');
            throw err;
        }
    }

     /**
     * NOTE: Uses KEYS, potentially slow on large datasets. Consider SCAN for production.
     */
    public static async GetIndexKeys(indexName: string): Promise<string[]> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger(indexName);
        if (!RedisEmbeddingServiceV2.instance) {
            throw new Error("Cannot get keys: No connected client exists");
        }
        logger.warn('GetIndexKeys uses KEYS command, potentially slow.');
        const pattern = `noderedis:${indexName}:*`;
        try {
            const keys = await RedisEmbeddingServiceV2.instance.keys(pattern);
            logger.info({ count: keys.length, pattern }, `Found keys`);
            return keys ? keys.map(key => key.replace(`noderedis:${indexName}:`, "")) : [];
        } catch (err) {
            logger.error({ err, pattern }, 'Failed to get keys using KEYS');
            throw err;
        }
    }

    /**
     * NOTE: Uses KEYS, potentially slow on large datasets. Consider SCAN for production.
     */
    public static async GetMemories(indexName: string): Promise<Memory[]> {
        const logger = RedisEmbeddingServiceV2._getOrCreateRedisLogger(indexName);
        if (!RedisEmbeddingServiceV2.instance) {
            throw new Error("Cannot get memories: No connected client exists");
        }
        logger.warn('GetMemories uses KEYS command, potentially slow.');
        const pattern = `noderedis:${indexName}:*`;
        try {
            const keys = await RedisEmbeddingServiceV2.instance.keys(pattern);
            logger.info({ count: keys.length, pattern }, `Found keys for memories`);
            return keys ? keys.map(key => {
                return { memory: key.replace(`noderedis:${indexName}:`, ""), redisKey: key }
            }) : [];
        } catch (err) {
             logger.error({ err, pattern }, 'Failed to get memories using KEYS');
             throw err;
        }
    }
} 