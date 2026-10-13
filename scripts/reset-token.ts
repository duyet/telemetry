/**
 * Operator tool for an owner who lost the admin token. Prints a new token and the D1 command
 * that stores its hash. It runs nothing: review the command, then run it yourself.
 *
 *   bun scripts/reset-token.ts <slug> [d1-database-id]
 */
import { isValidSlug, randomHex, sha256hex } from "../src/util.ts";

const [slug, db = "<db-id>"] = process.argv.slice(2);
if (!slug || !isValidSlug(slug)) {
	console.error("usage: bun scripts/reset-token.ts <slug> [d1-database-id]");
	process.exit(1);
}

const token = `tk_${randomHex(24)}`;
const sql = `UPDATE projects SET admin_hash = '${await sha256hex(token)}' WHERE slug = '${slug}'`;

console.log(`New admin token for ${slug} (give it to the owner, do not commit it):

  ${token}

Store its hash in D1. The output must show "changes": 1, else the slug does not exist:

  npx cf d1 raw ${db} --sql "${sql}"`);
