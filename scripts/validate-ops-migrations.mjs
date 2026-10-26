const { PGlite } = await import('@electric-sql/pglite');
const { readFile, readdir } = await import('node:fs/promises');
const db = new PGlite();
await db.exec(
  `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;`,
);
for (const f of (await readdir('supabase/migrations')).sort()) {
  try {
    await db.exec(await readFile('supabase/migrations/' + f, 'utf8'));
    console.log('OK', f);
  } catch (e) {
    console.error('FAIL', f, e.message, e.position);
    process.exit(1);
  }
}
await db.close();
