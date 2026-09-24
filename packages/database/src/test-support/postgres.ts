import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { databaseMigrationDefinitions } from "../migrations.js";

export const withPostgresTestDatabase = async <A>(use: (pool: Pool) => Promise<A>): Promise<A> => {
  const database = await PGlite.create({ extensions: { btree_gist } });

  const server = new PGLiteSocketServer({
    db: database,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });

  let pool: Pool | undefined;

  try {
    for (const migration of databaseMigrationDefinitions) {
      await database.exec(await readFile(migration.url, "utf8"));
    }

    await server.start();
    pool = new Pool({
      connectionString: `postgres://postgres@${server.getServerConn()}/postgres`,
      max: 1,
    });

    return await use(pool);
  } finally {
    try {
      await pool?.end();
    } finally {
      try {
        await server.stop();
      } finally {
        await database.close();
      }
    }
  }
};
