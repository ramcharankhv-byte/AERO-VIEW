#!/usr/bin/env node
// scripts/hash_gov_password.mjs
//
// One-shot helper: produce a bcrypt hash for a government admin password.
//
// USAGE
//   GOV_ADMIN_PASSWORD="<the-plaintext>" node scripts/hash_gov_password.mjs
//
// OUTPUT
//   Prints the hash on stdout. Copy it into data/gov_users.json as the
//   value for the admin email. The plaintext never lands in the repo.
//
// WHY A SCRIPT, NOT A NORMAL FIELD
// The plaintext password must not be committed. The .env file is gitignored,
// so reading it at process start and hashing it then is fine; the only
// thing in source control is the hash.

import bcrypt from 'bcryptjs';

const password = process.env.GOV_ADMIN_PASSWORD;
if (!password) {
  console.error('Set GOV_ADMIN_PASSWORD in the environment first.');
  process.exit(2);
}
if (password.length < 8) {
  console.error('GOV_ADMIN_PASSWORD must be at least 8 characters.');
  process.exit(2);
}

const COST = 12;
const hash = bcrypt.hashSync(password, COST);
console.log(hash);
