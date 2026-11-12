import type { Knex } from "knex";

/**
 * Atrium moves to Ward: profiles are re-keyed onto Ward's subject, and atrium's
 * own account tables are dropped.
 *
 * ## This migration destroys accounts, and that is the decision
 *
 * `users` and `sessions` go. Every account atrium had ceases to exist here and
 * is recreated in Ward, by hand, after this runs — the estate chose a **full
 * prune** over a migration path (`wzd_auth/corpus/wiki/decisions-accounts.md`)
 * because atrium and Ward key identity differently (atrium on a local `id`,
 * Ward on an opaque subject) and no mapping between them exists that was not
 * invented at cutover time.
 *
 * **Take a database copy before running this.** There is no `down` that can
 * bring a password hash back, and the `down` below says so rather than
 * pretending otherwise.
 *
 * ## Profiles are deleted; what was under them is NOT, here
 *
 * The profiles themselves are **deleted, not re-pointed**, because there is
 * nothing to re-point them to: their `user_id` names a row in a table this
 * migration drops, and no subject exists yet for the account that owned them.
 * D53 decided their children (`reading_progress`, `notes`, `note_folders` and
 * the LaTeX projects, all keyed on `profile_id`) go with them, and this
 * migration was written expecting a cascade to do that.
 *
 * **It does not.** Foreign keys are off for the rebuild below, and with them
 * off SQLite's `DROP TABLE` fires no `ON DELETE` action; `notes` and
 * `note_folders` are `RESTRICT` besides. Every child row survives, pointing at
 * a profile id that no longer exists. The prune D53 decided on is carried out
 * by `20260925000000-prune-cutover-orphans` (brief 60). This file's behaviour
 * is left as it was, because it may already have run somewhere.
 *
 * ## SQLite cannot ALTER a foreign key, so `profiles` is rebuilt
 *
 * The table is recreated with `subject` in place of `user_id` and no FK at all
 * — there is no local table for a subject to reference, and there must not be:
 * Ward owns accounts, and a `users` table here would be a second, stale answer
 * to "who exists". Referential integrity for the subject is Ward's;
 * atrium's guarantee is narrower and still worth having — a profile row always
 * carries the subject that owns it, and every child is keyed on the profile.
 */
export async function up(knex: Knex): Promise<void> {
  // Off for the rebuild, and OUTSIDE any transaction: SQLite silently ignores
  // this pragma inside one, which would make the drops below fail on the FKs
  // they are removing. `bootstrap.ts` runs migrations with
  // `disableTransactions: true` for exactly this reason.
  await knex.raw("PRAGMA foreign_keys = OFF");

  try {
    /**
     * Order matters and is dependency-first. `profiles` references `users`, and
     * `sessions` references both — dropping `users` while `sessions` still
     * points at it leaves a table whose FK names something absent, which SQLite
     * tolerates until the next integrity check and then does not.
     */
    await knex.schema.dropTableIfExists("sessions");

    // D53 meant everything profile-scoped to go with the profiles. With
    // foreign keys off it does not: the children survive as orphans, and
    // `20260925000000-prune-cutover-orphans` deletes them (brief 60).
    await knex.schema.dropTableIfExists("profiles");
    await knex.schema.dropTableIfExists("users");

    await knex.schema.createTable("profiles", (table) => {
      table.text("id").primary();
      /**
       * Ward's subject. Opaque, stable, never recycled — and deliberately not a
       * foreign key, because the table it would reference does not exist in
       * this database and must not.
       */
      table.text("subject").notNullable();
      table.text("name").notNullable();
      table.text("color").notNullable();
      table.integer("is_default").notNullable().defaultTo(0);
      table.text("preferences");
      table.text("created_at").notNullable();
      // Same rule as before, re-keyed: one profile name per account.
      table.unique(["subject", "name"], { indexName: "profiles_subject_name" });
    });

    // The guard reads this on every request; the account's profile list reads
    // it on every profile screen.
    await knex.schema.raw(`CREATE INDEX IF NOT EXISTS profiles_subject_idx ON profiles (subject)`);

    /**
     * Which profile a device last activated — the replacement for
     * `sessions.active_profile_id`, keyed on the Ward token's `sid` so that
     * switching profiles on one device still does not switch the others.
     * See `profiles/profile-selection.model.ts`.
     */
    await knex.schema.createTable("profile_selections", (table) => {
      table.text("subject").notNullable();
      table.text("sid").notNullable();
      table
        .text("profile_id")
        .notNullable()
        .references("id")
        .inTable("profiles")
        // A deleted profile takes its selections with it. The guard falls back
        // to the account's default when there is no row, so this is a clean
        // outcome rather than a dangling one.
        .onDelete("CASCADE");
      table.text("updated_at").notNullable();
      table.primary(["subject", "sid"]);
    });
  } finally {
    // Restored even if a statement above threw, so a failed migration does not
    // leave the connection with integrity checking off for everything after it.
    await knex.raw("PRAGMA foreign_keys = ON");
  }
}

/**
 * There is no meaningful down.
 *
 * Reversing this would have to invent password hashes for accounts that no
 * longer exist and re-derive local ids for subjects Ward issued. It drops what
 * it created so a re-run of `up` is not blocked, and it is explicit that the
 * data is not coming back — the recovery path is the database copy taken before
 * `up` ran, which is the only thing that ever could have been.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("profile_selections");
  await knex.schema.dropTableIfExists("profiles");
}
