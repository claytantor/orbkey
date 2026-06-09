# 04 — Operations

## Day-to-day commands

`/add` `/get` `/edit` `/rm` `/search` `/label` `/note` `/sync` `/lock` `/rotate`
`/exit` `/help`. Plain typing filters the list live (FTS5). `/help` shows the
full reference; values are masked by default (`Ctrl+R` reveals/hides).
`Ctrl+Q` exits with a final checkpoint + sync if dirty.

## Rotate the password

`/rotate` → *Password*. This re-derives the keychain master key from the new
password and re-wraps the keychain blobs only — **no AWS calls, and the vault is
unchanged**. Useful and cheap; do it freely.

## Rotate the IAM key

1. Create a new access key for the orbkey IAM user (IAM console, or roll it via
   re-deploy after deleting the old `CfnAccessKey`).
2. In orbkey: `/rotate` → *IAM key*, paste the new key id/secret.
3. Delete the old access key in IAM.

## KMS key rotation

The CMK has `enable_key_rotation=True` (annual AWS-managed rotation). This is
transparent: old data keys remain decryptable, new uploads use the rotated
backing key. **Nothing to do** — and because orbkey does envelope encryption
(`kms:GenerateDataKey` per push, `kms:Decrypt` per pull), rotation never
requires re-encrypting the S3 object.

## Point-in-time recovery (S3 versioning)

The S3 bucket is versioned. To recover an earlier vault:

```bash
aws s3api list-object-versions --bucket <bucket> --prefix vaults/default/vault.bin
# copy a prior VersionId over the current object:
aws s3api copy-object --bucket <bucket> --key vaults/default/vault.bin \
  --copy-source "<bucket>/vaults/default/vault.bin?versionId=<VERSION_ID>"
```

This changes the object's ETag. On the next launch, orbkey's sync sees the
changed ETag and (if the device is clean) pulls it; if the device has unpushed
local changes it raises a conflict (below).

## Multiple devices & conflicts

Each device keeps its own `state.json` (`last_synced_etag` + `local_dirty`;
`src/core/config.ts::DeviceState`) and a local encrypted checkpoint. Pushes are
optimistic-concurrency controlled:

- First push uses **`If-None-Match: *`** (create-if-absent).
- Later pushes use **`If-Match: <last_synced_etag>`**.

If two devices both change the vault, the second push gets a **412** and orbkey
shows the **conflict screen** (`src/core/sync.ts`):

- **Keep local** — your copy overwrites remote (unconditional PutObject).
- **Keep remote** — discard local, adopt remote.
- **Save a local copy, then pull** — writes an encrypted timestamped checkpoint
  `checkpoints/conflict-local-<ts>.checkpoint`, then adopts remote.

There is no auto-merge in v1.

## Teardown

```bash
cd devops/cdk
cdk destroy
```

The S3 bucket and KMS key are `RETAIN`, so `cdk destroy` will **not** delete
your vault or key — it removes the IAM user, access key, and stack scaffolding.
To fully remove the data afterwards: empty and delete the bucket, then schedule
the CMK for deletion in the console.

> After `cdk destroy` the IAM access key is gone, so the CLI can no longer reach
> S3/KMS. Your local vault still opens offline from the last checkpoint, but
> sync will fail until you re-deploy and `/rotate` → *IAM key* with new creds.

Next: [05-troubleshooting.md](05-troubleshooting.md).
