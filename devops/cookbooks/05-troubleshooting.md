# 05 — Troubleshooting

All local file paths below honor `$XDG_CONFIG_HOME` (default `~/.config`); the
orbkey config dir is `$XDG_CONFIG_HOME/orbkey` (`src/core/config.ts`).

## "account id mismatch" on first run / unlock

The IAM key resolves to a different AWS account than the account id you entered.
`validateCreds` calls `sts:GetCallerIdentity` and asserts the account matches.
Re-check `account_id` and `access_key_id` / `secret_access_key` from your CDK
outputs. If you rotated the key, update orbkey with `/rotate` → *IAM key*.

## Auth failures (AccessDenied / expired key)

- **AccessDenied on S3:** the IAM user's policy is scoped to the bucket's vault
  prefix (`vaults/default/*`) for `s3:GetObject` / `s3:PutObject`, and to the
  same prefix for `s3:ListBucket`. Confirm you deployed the stack (cookbook 02)
  and that the `bucket` / `object_key` in `config.json` match the outputs. The
  `object_key` must stay under `vaults/default/` or the prefix-scoped policy
  will deny it.
- **AccessDenied on KMS `DescribeKey` at first run:** the CMK grant must include
  `kms:DescribeKey`. This stack grants it (the original Python-era stack did
  not — if you ported an older template, re-deploy this one). Confirm with the
  diagnostics below.
- **InvalidAccessKeyId / SignatureDoesNotMatch:** the access key was deleted or
  mistyped. Create a fresh key and `/rotate` → *IAM key*.

## Conditional-write / conflict (HTTP 412)

A `412 PreconditionFailed` on push means the remote ETag no longer matches your
device's `last_synced_etag` — another device advanced the vault. This is
expected optimistic-concurrency behavior, not an error. orbkey shows the
conflict screen:

- **Keep local** — your local copy overwrites remote (force push).
- **Keep remote** — discard your local changes and adopt remote.
- **Save a local copy, then pull** — orbkey writes an encrypted timestamped
  checkpoint (`checkpoints/conflict-local-<ts>.checkpoint`) and then adopts
  remote. You can open that copy later with your password.

## Offline behavior

With no network, orbkey loads your last local checkpoint and shows `OFFLINE`.
Changes stay `local_dirty` and are pushed on the next online `/sync` or launch.
First run cannot be completed offline (it must reach AWS to validate).

## Corrupted / unreadable checkpoint

If the local checkpoint won't open (and you have network), re-pull from S3:
delete the device-local cache and relaunch, then unlock.

```bash
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/orbkey/state.json"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/orbkey/checkpoints/vault.checkpoint"
orbkey      # fresh device → pulls vault from S3
```

This does **not** touch `keychain.json` (your password/creds) or `config.json`
(your locators) — only the cached vault and per-device sync state.

## KMS access-denied diagnostics

A `kms:Decrypt` / `kms:GenerateDataKey` / `kms:DescribeKey` AccessDenied usually
means the grant didn't attach to the IAM user, or you entered the wrong key.
Confirm `kms_key_id` in `config.json` matches the deployed CMK ARN and that
you're using the orbkey IAM user's key (not your deploy principal):

```bash
aws kms describe-key --key-id <kms_key_arn>
```

## Wrong password

orbkey fails closed on a wrong password (GCM tag verification) — no partial
data. If you've forgotten it but still have your IAM key+secret, delete
`keychain.json` and re-run first run to set a new password; the vault is pulled
fresh from S3. `config.json` is preserved.

```bash
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/orbkey/keychain.json"
```

## CDK `cdk synth` / `cdk deploy` schema mismatch

> "This CDK CLI is not compatible with the CDK library used by your
> application … Cloud assembly schema version mismatch"

Your global `cdk` CLI is older than `aws-cdk-lib`. Either upgrade the CLI
(`npm install -g aws-cdk@latest`) or run a matching CLI ad hoc:

```bash
cd devops/cdk
npx --yes aws-cdk@latest synth
```
