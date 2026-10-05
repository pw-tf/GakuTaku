import { db, type Tx } from '../db';
import { Collection, type Sql } from './collection';

/** The app's {@link Sql} adapter over the worker database (src/db). */
function txSql(tx: Tx): Sql {
  const self: Sql = {
    all: (sql, params) => tx.getAll(sql, params),
    run: async (sql, params) => {
      await tx.execute(sql, params);
    },
    runMany: (sql, rows) => tx.executeMany(sql, rows),
    transaction: (fn) => fn(self),
  };
  return self;
}

export const appSql: Sql = {
  all: (sql, params) => db.getAll(sql, params),
  run: async (sql, params) => {
    await db.execute(sql, params);
  },
  runMany: (sql, rows) => db.writeTransaction((tx) => tx.executeMany(sql, rows)),
  transaction: (fn) => db.writeTransaction((tx) => fn(txSql(tx))),
};

/** The one collection the app works with. */
export const col = new Collection(appSql);
