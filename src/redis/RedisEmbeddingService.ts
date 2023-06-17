import { RedisClientType, SchemaFieldTypes, VectorAlgorithms, createClient } from "redis";
import { Logger } from "../logger/logger";

function float32Buffer(arr: number[]) {
    return Buffer.from(new Float32Array(arr).buffer);
}

export interface embeddingData {
    text: string,
    embedding: number[]
}

export interface Memory {
    memory: string,
    redisKey: string
}

export interface RedisEmbeddingService {
    createClient(password: string): Promise<void>,
    deleteClient(): Promise<void>,
    getClient(): Promise<RedisClientType>,
    CreateIndexForEmbedding(indexName: string): Promise<void>,
    setEmbeddingData(indexName: string, key: string, data: embeddingData): Promise<void>,
    performVectorSimilarity(indexName: string, embedding: number[]): Promise<string[]>
}

export class RedisEmbeddingService implements RedisEmbeddingService {

    private static instance: RedisClientType;

    private static indexExists(indexName: string): Promise<boolean> {
        if (!RedisEmbeddingService.instance) {
            throw new Error("Cannot see index info: No client exists");
        }
        return RedisEmbeddingService.instance.ft.info(`idx:${indexName}`).then(() => true, () => false);;
    }

    public static async CreateClient(password: string): Promise<void> {
        try {
            RedisEmbeddingService.instance = createClient({
                url: `redis://redis:6379`,
                password: password
                });
                await RedisEmbeddingService.instance.connect();
        } catch(error) {
            if (RedisEmbeddingService.instance) {
                RedisEmbeddingService.instance = undefined;
            }
            throw error;
        }
    }

    public static async DeleteClient(): Promise<void> {
        try {
            if (!RedisEmbeddingService.instance) {
                throw new Error("Cannot delete client: No client exists");
            }
            RedisEmbeddingService.instance.disconnect();
            RedisEmbeddingService.instance = undefined;
        } catch(error) {
            if (RedisEmbeddingService.instance) {
                RedisEmbeddingService.instance = undefined;
            }
            throw error;
        }
    }

    public static async GetClient(): Promise<RedisClientType> {
        if (!RedisEmbeddingService.instance) {
            throw new Error("Cannot get client: No client exists");
        }
        return RedisEmbeddingService.instance;
    }

    public static async CreateIndexForEmbedding(indexName: string): Promise<void> {
        if (!RedisEmbeddingService.instance) {
            throw new Error("Cannot create index: No connected client exists");
        }
        const logger = Logger.getLogger();
        try {
            await RedisEmbeddingService.instance.ft.create(`idx:${indexName}`, {
                "embedding": {
                    type: SchemaFieldTypes.VECTOR,
                    ALGORITHM: VectorAlgorithms.HNSW,
                    TYPE: "FLOAT32",
                    DIM: 1536,
                    DISTANCE_METRIC: "COSINE"
                }
            }, {
                ON: 'HASH',
                PREFIX: `noderedis:${indexName}`
            });
            logger.debug(`Created index ${indexName}`);
        } catch (e) {
            if ((e as Error).message === 'Index already exists') {
                //logger.debug(`Index ${indexName} exists already`); //is spammy
              } else {
                // Something else went wrong
                logger.error(e);
                throw e;
              }
        }
    }

    public static async SetEmbeddingData(indexName: string, value: embeddingData): Promise<void> {
        if (!RedisEmbeddingService.instance) {
            throw new Error("Cannot set key: No connected client exists");
        }
        const logger = Logger.getLogger();
        if (!(await RedisEmbeddingService.indexExists(indexName))) {
            throw new Error(`Cannot set key: Index ${indexName} does not exist`);
        }
        await RedisEmbeddingService.instance.hSet(`noderedis:${indexName}:${value.text}`, { embedding: float32Buffer(value.embedding) });
        logger.debug(`Created value at key: ${value.text.substring(0, 10)}... for index: ${indexName}`);
    }

    public static async DeleteKey( key: string): Promise<void> {
        if (!RedisEmbeddingService.instance) {
            throw new Error("Cannot delete key: No connected client exists");
        }
        const logger = Logger.getLogger();
        await RedisEmbeddingService.instance.del(key);
        logger.debug(`Deleted value at key: ${key}`);
    }

    public static async PerformVectorSimilarity(indexName: string, embedding: number[]): Promise<string[]> {
        return RedisEmbeddingService.instance.ft.search(`idx:${indexName}`, '*=>[KNN 10 @embedding $BLOB AS dist]', {
            PARAMS: {
                BLOB: float32Buffer(embedding)
            },
            SORTBY: 'dist',
            DIALECT: 2,
            RETURN: ['dist']
        })
        .then(res => res.documents.map(document => document.id.replace(`noderedis:${indexName}:`, "")));
    }

    public static async GetIndexKeys(indexName: string): Promise<string[]> {
        // .keys is bad performance wise but shouldn't be a problem yet given small scale
        return RedisEmbeddingService.instance.keys(`noderedis:${indexName}:*`)
        .then(res => res ? res.map(key => key.replace(`noderedis:${indexName}:`, "")) : []);
    }

    public static async GetMemories(indexName: string): Promise<Memory[]> {
        // .keys is bad performance wise but shouldn't be a problem yet given small scale
        return RedisEmbeddingService.instance.keys(`noderedis:${indexName}:*`)
        .then(res => res ? res.map(key => {
            return { memory: key.replace(`noderedis:${indexName}:`, ""), redisKey: key}
        }) : []);
    }
}
