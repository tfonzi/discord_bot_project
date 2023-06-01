import { RedisJSON } from "@redis/json/dist/commands";
import { RedisClientType, SchemaFieldTypes, VectorAlgorithms, createClient } from "redis";

export interface EncodingData {
    text: string,
    encoding: Buffer
}

export interface RedisEncodingsService {
    createClient(password: string): Promise<void>,
    deleteClient(): Promise<void>,
    getClient(): Promise<RedisClientType>,
    createIndexForEncoding(indexName: string): Promise<void>,
    setEncodingData(indexName: string, key: string, data: EncodingData): Promise<void>
    //getEncodingData(indexName: string, key: string): Promise<EncodingData>
}

export class RedisEncodingsService implements RedisEncodingsService {

    private static instance: RedisClientType;

    private static indexExists(indexName: string): Promise<boolean> {
        if (!RedisEncodingsService.instance) {
            throw new Error("Cannot see index info: No client exists");
        }
        return RedisEncodingsService.instance.ft.info(`idx:${indexName}`).then(() => true, () => false);;
    }

    public static async CreateClient(password: string): Promise<void> {
        try {
            RedisEncodingsService.instance = createClient({
                url: `redis://redis:6379`,
                password: password
                });
                await RedisEncodingsService.instance.connect();
        } catch(error) {
            if (RedisEncodingsService.instance) {
                RedisEncodingsService.instance = undefined;
            }
            throw error;
        }
    }

    public static async DeleteClient(): Promise<void> {
        try {
            if (!RedisEncodingsService.instance) {
                throw new Error("Cannot delete client: No client exists");
            }
            RedisEncodingsService.instance.disconnect();
            RedisEncodingsService.instance = undefined;
        } catch(error) {
            if (RedisEncodingsService.instance) {
                RedisEncodingsService.instance = undefined;
            }
            throw error;
        }
    }

    public static async GetClient(): Promise<RedisClientType> {
        if (!RedisEncodingsService.instance) {
            throw new Error("Cannot get client: No client exists");
        }
        return RedisEncodingsService.instance;
    }

    public static async CreateIndexForEncoding(indexName: string): Promise<void> {
        if (!RedisEncodingsService.instance) {
            throw new Error("Cannot create index: No connected client exists");
        }
        try {
            await RedisEncodingsService.instance.ft.create(`idx:${indexName}`, {
                "encoding": {
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
            console.log(`Created index ${indexName}`);
        } catch (e) {
            if ((e as Error).message === 'Index already exists') {
                console.log(`Index ${indexName} exists already`);
              } else {
                // Something else went wrong
                console.error(e);
                throw e;
              }
        }
    }

    public static async SetEncodingData(indexName: string, value: EncodingData): Promise<void> {
        if (!RedisEncodingsService.instance) {
            throw new Error("Cannot set key: No connected client exists");
        }
        if (!(await RedisEncodingsService.indexExists(indexName))) {
            throw new Error(`Cannot set key: Index ${indexName} does not exist`);
        }
        await RedisEncodingsService.instance.hSet(`noderedis:${indexName}:${value.text}`, { encoding: Buffer.from(value.encoding) });
        console.log(`Created value: ${value.encoding.toString().substring(0,10)} at key: ${value.text.substring(0, 10)}... for index: ${indexName}`);
    }

    // public static async GetEncodingData(indexName: string, key: string): Promise<EncodingData> {
    //     if (!RedisEncodingsService.instance) {
    //         throw new Error("Cannot get key: No connected client exists");
    //     }
    //     if (!(await RedisEncodingsService.indexExists(indexName))) {
    //         throw new Error(`Cannot get key: Index ${indexName} does not exist`);
    //     }
    //     await RedisEncodingsService.instance.hGet(`noderedis:${indexName}:${data.text}`);
    //     const result = await RedisEncodingsService.instance.json.get(`noderedis:${indexName}:${key}`, {
    //         path: [
    //             '.text',
    //             '.encodings'
    //         ]
    //     });
    //     if (!result) {
    //         throw new Error(`Cannot get key: Key ${key.substring(0, 10)}... does not exist`);
    //     }
    //     const data: EncodingData = { 
    //         text: result[".text"],
    //         encodings: result[".encodings"]
    //     };
    //     console.log(`Got value "${JSON.stringify(data)}" at key: ${key}`);
    //     return data;
    // }
}
