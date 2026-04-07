import { Pool, type PoolClient } from "pg";
import { beginDbTiming } from "@/app/lib/request-timing";

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!global._pgPool) {
    global._pgPool = new Pool({ connectionString });
  }
  return global._pgPool;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const endDbTiming = beginDbTiming();
  const result = await getPool().query(text, params).finally(() => {
    endDbTiming();
  });
  return result.rows;
}

function wrapClientWithTiming(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "query" || typeof value !== "function") {
        return value;
      }

      return async (...args: any[]) => {
        const endDbTiming = beginDbTiming();
        try {
          return await (value as (...params: any[]) => Promise<any>).apply(target, args);
        } finally {
          endDbTiming();
        }
      };
    },
  }) as PoolClient;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const timedClient = wrapClientWithTiming(client);
  try {
    await timedClient.query("BEGIN");
    const result = await fn(timedClient);
    await timedClient.query("COMMIT");
    return result;
  } catch (err) {
    await timedClient.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
