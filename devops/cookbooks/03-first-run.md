# 03 — First run

## Install and launch

orbkey is a Node.js CLI (TypeScript / Ink). It requires an interactive TTY.

From a published npm package (once available):

```bash
npm install -g orbkey && orbkey
```

Straight from this repo:

```bash
git clone https://github.com/claytantor/orbkey-ts
cd orbkey-ts
npm install
npm run build && node dist/index.js   # the built binary (bin: orbkey)
# or, without building:
npm run dev                            # tsx src/index.ts
```

## Complete the setup form

On a machine with no orbkey config (`~/.config/orbkey/keychain.json` absent —
see `src/core/config.ts::isFirstRun`), the first-run screen asks for the values
from your CDK outputs (cookbook 02) plus a new password:

| Field | From CDK output | Lands in |
|---|---|---|
| AWS account id | `account_id` | `keychain.json` |
| Region | `region` | `keychain.json` |
| S3 bucket name | `bucket_name` | `config.json` → `bucket` |
| KMS key id / arn | `kms_key_arn` | `config.json` → `kms_key_id` |
| Vault object key | `vault_object_key` (default `vaults/default/vault.bin`) | `config.json` → `object_key` |
| IAM access key id | `access_key_id` | `keychain.json` |
| IAM secret access key | `secret_access_key` | `keychain.json` |
| New vault password (+confirm) | *you choose* | derives the keychain master key |

The form writes two files under `$XDG_CONFIG_HOME/orbkey` (default
`~/.config/orbkey`):

- `config.json` — non-secret locators, snake_case:
  ```json
  {
    "bucket": "orbkeystack-orbkeybucket-xxxxxxxx",
    "kms_key_id": "arn:aws:kms:us-east-1:123456789012:key/....",
    "object_key": "vaults/default/vault.bin"
  }
  ```
- `keychain.json` — password-encrypted DB key + IAM credentials.

## What validation runs (and the permissions it needs)

Before writing anything, orbkey validates the credentials
(`src/core/aws.ts::validateCreds`), in order:

1. `sts:GetCallerIdentity` — and asserts the resolved account **equals** the
   account id you entered (else "account id mismatch").
2. `s3:ListBucket` on the vault prefix (`ListObjectsV2`, `MaxKeys: 1`).
3. `kms:DescribeKey` on the CMK.

All three are granted to the `OrbkeyUser` by the stack (STS needs no grant;
`s3:ListBucket` is prefix-scoped; `kms:DescribeKey` is CMK-scoped). It then
derives your DB key from the password, writes `keychain.json`, and runs the
launch sync: it either **pulls** an existing vault from S3 or **creates** an
empty one and **pushes** it with `If-None-Match: *` (create-if-absent).

## Verify a round-trip

1. `/add` a test secret (key `demo`, any value).
2. `Ctrl+Q` (or `/exit`) — this checkpoints, pushes to S3, and quits.
3. Relaunch `orbkey`, enter your password, confirm `demo` is present (pulled
   back from S3).

Every run after the first prompts **only for the password**.

Next: [04-operations.md](04-operations.md).
