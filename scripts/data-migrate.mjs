import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const [action, directory] = process.argv.slice(2);
if (!['backup', 'restore', 'verify'].includes(action) || !directory) {
  console.error('Usage: npm run data:backup|data:restore|data:verify -- /absolute/backup-directory');
  process.exit(1);
}
const source = action === 'backup';
const rawUrl = process.env[source ? 'SOURCE_DATABASE_URL' : 'TARGET_DATABASE_URL'];
if (!rawUrl) throw new Error(`Set ${source ? 'SOURCE_DATABASE_URL' : 'TARGET_DATABASE_URL'} explicitly`);
const url = new URL(rawUrl);
if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected PostgreSQL URL');
url.searchParams.delete('schema');
const connectionString = url.toString();
const client = new Client({ connectionString });
const folder = resolve(directory);
const archive = join(folder, 'database.dump');
const manifestFile = join(folder, 'manifest.json');
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function fingerprint(db) {
  const { rows } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const tables = {};
  for (const { tablename } of rows) {
    // Only row hashes are aggregated, not image data. Includes passwords, images and vectors.
    const result = await db.query(`SELECT count(*)::text AS count, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS hash FROM (SELECT md5(row_to_json(t)::text) AS h FROM public.${quote(tablename)} t) hashed`);
    tables[tablename] = result.rows[0];
  }
  return tables;
}
async function run(tool, args) {
  await new Promise((resolve, reject) => {
    // Connection secrets are passed only through the child environment.
    const child = spawn(tool, args, { env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), ...(url.searchParams.has("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode") } : {}) }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    child.on('error', () => reject(new Error(`${tool} unavailable; install PostgreSQL 17 client tools`)));
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${tool} failed (${code}); check PostgreSQL version, privileges and connection configuration`)));
  });
}
try {
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  if (source) {
    await mkdir(folder, { mode: 0o700 }); // Refuse to overwrite an existing backup directory.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const tables = await fingerprint(client);
    if (!tables.users || !tables.messages) throw new Error('Source is not an Agent database');
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snapshot}`, '--file', archive]);
    await chmod(archive, 0o600);
    await writeFile(manifestFile, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sha256: await digest(archive), tables }, null, 2), { mode: 0o600, flag: 'wx' });
    await client.query('COMMIT');
    console.log(`Backup complete: ${folder}. Keep the dump and manifest together; both contain sensitive data.`);
  } else {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.version !== 1 || await digest(archive) !== manifest.sha256) throw new Error('Archive integrity check failed');
    if (action === 'restore') {
      const count = (await client.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'")).rows[0].count;
      if (count !== 0) throw new Error('Target must be an empty, dedicated database. Existing tables will never be overwritten.');
      await run('pg_restore', ['--dbname', decodeURIComponent(url.pathname.slice(1)), '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', archive]);
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await fingerprint(client);
    await client.query('COMMIT');
    if (JSON.stringify(tables) !== JSON.stringify(manifest.tables)) throw new Error('Data verification failed: table counts or row fingerprints differ. Do not switch clients.');
    console.log('Verification passed: all public tables, accounts, messages, images, vectors and migration history match the backup.');
  }
} catch (error) {
  console.error(error instanceof Error && !/postgres(?:ql)?:\/\//.test(error.message) ? error.message : 'Database operation failed; check connection and permissions');
  process.exitCode = 1;
} finally { await client.end(); }
