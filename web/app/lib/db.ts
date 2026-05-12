import { Pool, type PoolClient } from "pg";
import { beginDbTiming } from "@/app/lib/request-timing";
import { requireRuntimeEnv } from "@/app/lib/runtime-env";

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: { connectionString: string; pool: Pool } | undefined;
}

async function getPool() {
  const connectionString = await requireRuntimeEnv("DATABASE_URL");
  if (global._pgPool?.connectionString !== connectionString) {
    const previousPool = global._pgPool?.pool;
    global._pgPool = { connectionString, pool: new Pool({ connectionString }) };
    if (previousPool) {
      void previousPool.end().catch(() => {});
    }
  }
  return global._pgPool.pool;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const endDbTiming = beginDbTiming();
  const result = await (await getPool()).query(text, params).finally(() => {
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
  const client = await (await getPool()).connect();
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
