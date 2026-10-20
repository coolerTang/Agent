// Runs against temporary databases only; requires local PostgreSQL and Docker client tools.
import 'dotenv/config';
import { Client } from 'pg';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete('schema');
const admin = new Client({ connectionString: url.toString() });
const prefix = `migration_test_${Date.now()}`;
const source = `${prefix}_source`, target = `${prefix}_target`;
const folder = await mkdtemp(join(tmpdir(), 'agent-migration-'));
const bin = join(folder, 'bin'); await mkdir(bin);
// Adapt installed container tools to local file paths without installing host binaries.
const wrapper = `#!/usr/bin/env python3
import os, sys, subprocess
args=sys.argv[1:]
tool=os.path.basename(sys.argv[0])
cmd=['docker','exec','-i','-e','PGHOST=127.0.0.1','-e','PGPORT=5432','-e','PGUSER','-e','PGPASSWORD','-e','PGDATABASE',os.environ.get('TEST_PG_CONTAINER','aiagent-postgres-1'),tool]
if tool=='pg_dump':
 i=args.index('--file'); path=args[i+1]; del args[i:i+2]
 with open(path,'wb') as output: result=subprocess.run(cmd+args,stdout=output)
else:
 path=args.pop()
 with open(path,'rb') as input: result=subprocess.run(cmd+args,stdin=input)
sys.exit(result.returncode)
`;
for (const tool of ['pg_dump', 'pg_restore']) await writeFile(join(bin, tool), wrapper, { mode: 0o700 });
const sourceUrl = new URL(url); sourceUrl.pathname = `/${source}`;
const targetUrl = new URL(url); targetUrl.pathname = `/${target}`;
function run(action, success = true) {
  const result = spawnSync(process.execPath, ['scripts/data-migrate.mjs', action, join(folder, 'backup')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOURCE_DATABASE_URL: sourceUrl.toString(), TARGET_DATABASE_URL: targetUrl.toString() } });
  assert.equal(result.status === 0, success, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${source}"`);
  await admin.query(`CREATE DATABASE "${target}"`);
  const db = new Client({ connectionString: sourceUrl.toString() }); await db.connect();
  try {
    await db.query(`CREATE EXTENSION vector; CREATE TABLE users(id text PRIMARY KEY, password_hash text); CREATE TABLE messages(id text PRIMARY KEY, content text, images jsonb, created_at timestamptz); CREATE TABLE message_embeddings(id text, embedding vector(3)); INSERT INTO users VALUES ('alice','synthetic-password-hash'); INSERT INTO messages VALUES ('message','你好','[{"name":"image.png","dataUrl":"data:image/png;base64,fixture"}]','2026-10-20T00:00:00Z'); INSERT INTO message_embeddings VALUES ('message','[1,2,3]');`);
  } finally { await db.end(); }
  run('backup');
  run('restore');
  run('verify');
  assert.match(run('restore', false), /empty/);
  const db2 = new Client({ connectionString: targetUrl.toString() }); await db2.connect();
  try { await db2.query("UPDATE messages SET content='tampered'"); } finally { await db2.end(); }
  assert.match(run('verify', false), /verification failed/);
  const archive = join(folder, 'backup', 'database.dump');
  await writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from('corruption')]));
  assert.match(run('verify', false), /integrity check failed/);
  console.log('Migration rehearsal passed: snapshot backup, restore, data checks, nonempty target refusal, tamper and corruption detection.');
} finally {
  for (const name of [source, target]) await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {});
  await admin.end();
  await rm(folder, { recursive: true, force: true });
}
