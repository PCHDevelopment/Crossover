import type { PoolClient } from "@crossover/db";

const EXCLUDED_TABLES = ["room_deletion_audit", "room_leases", "rooms"];

const NULLIFIED_FOREIGN_KEY_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  messages: new Set(["reply_to"]),
  decisions: new Set(["supersedes"]),
  changesets: new Set(["conflict_id", "applied_revision"]),
  conflicts: new Set(["resolution_changeset_id"]),
  workspace_revisions: new Set(["changeset_id"]),
};

interface RoomTableRow {
  table_name: string;
}

interface ForeignKeyRow {
  child_table: string;
  parent_table: string;
  child_columns: string[];
}

/** Derive a deterministic child-before-parent delete order from the current public schema. */
export async function deriveRoomScopedDeleteOrder(client: PoolClient): Promise<string[]> {
  const { rows: roomTableRows } = await client.query<RoomTableRow>(
    `SELECT relation.relname AS table_name
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS schema ON schema.oid = relation.relnamespace
       JOIN pg_catalog.pg_attribute AS room_column
         ON room_column.attrelid = relation.oid AND room_column.attname = 'room_id'
      WHERE schema.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND room_column.attnum > 0
        AND NOT room_column.attisdropped
        AND relation.relname <> ALL($1::text[])
      ORDER BY relation.relname`,
    [EXCLUDED_TABLES],
  );

  const tables = roomTableRows.map((row) => row.table_name);
  const tableSet = new Set(tables);
  const { rows: foreignKeys } = await client.query<ForeignKeyRow>(
    `SELECT child.relname AS child_table,
            parent.relname AS parent_table,
            array_agg(child_column.attname::text ORDER BY child_key.ordinality) AS child_columns
       FROM pg_catalog.pg_constraint AS constraint_row
       JOIN pg_catalog.pg_class AS child ON child.oid = constraint_row.conrelid
       JOIN pg_catalog.pg_namespace AS child_schema ON child_schema.oid = child.relnamespace
       JOIN pg_catalog.pg_class AS parent ON parent.oid = constraint_row.confrelid
       JOIN pg_catalog.pg_namespace AS parent_schema ON parent_schema.oid = parent.relnamespace
       JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY
         AS child_key(attnum, ordinality) ON TRUE
       JOIN pg_catalog.pg_attribute AS child_column
         ON child_column.attrelid = child.oid AND child_column.attnum = child_key.attnum
       JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY
         AS parent_key(attnum, ordinality) ON parent_key.ordinality = child_key.ordinality
      WHERE constraint_row.contype = 'f'
        AND child_schema.nspname = 'public'
        AND parent_schema.nspname = 'public'
        AND child.relkind IN ('r', 'p')
        AND parent.relkind IN ('r', 'p')
        AND child.relname <> ALL($1::text[])
        AND parent.relname <> ALL($1::text[])
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute AS room_column
           WHERE room_column.attrelid = child.oid
             AND room_column.attname = 'room_id'
             AND room_column.attnum > 0
             AND NOT room_column.attisdropped
        )
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute AS room_column
           WHERE room_column.attrelid = parent.oid
             AND room_column.attname = 'room_id'
             AND room_column.attnum > 0
             AND NOT room_column.attisdropped
        )
      GROUP BY constraint_row.oid, child.relname, parent.relname
      ORDER BY child.relname, parent.relname`,
    [EXCLUDED_TABLES],
  );

  const dependents = new Map(tables.map((table) => [table, new Set<string>()]));
  const remainingChildren = new Map(tables.map((table) => [table, 0]));

  for (const foreignKey of foreignKeys) {
    if (
      foreignKey.child_columns.some((column) =>
        NULLIFIED_FOREIGN_KEY_COLUMNS[foreignKey.child_table]?.has(column),
      )
    ) {
      continue;
    }
    if (!tableSet.has(foreignKey.child_table) || !tableSet.has(foreignKey.parent_table)) {
      continue;
    }
    const parents = dependents.get(foreignKey.child_table);
    if (!parents || parents.has(foreignKey.parent_table)) continue;
    parents.add(foreignKey.parent_table);
    remainingChildren.set(
      foreignKey.parent_table,
      (remainingChildren.get(foreignKey.parent_table) ?? 0) + 1,
    );
  }

  const ready = tables.filter((table) => remainingChildren.get(table) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const child = ready.shift();
    if (!child) break;
    order.push(child);
    for (const parent of dependents.get(child) ?? []) {
      const remaining = (remainingChildren.get(parent) ?? 0) - 1;
      remainingChildren.set(parent, remaining);
      if (remaining === 0) {
        ready.push(parent);
        ready.sort();
      }
    }
  }

  if (order.length !== tables.length) {
    const cycleTables = tables.filter((table) => !order.includes(table)).sort();
    throw new Error(
      `Cannot derive room purge order; foreign-key cycle remains among tables: ${cycleTables.join(", ")}`,
    );
  }

  return order;
}

/** Quote a relation name returned by PostgreSQL's catalog before using it as an identifier. */
export function quoteRoomPurgeIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
