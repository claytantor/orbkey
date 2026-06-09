# 02 — Deploy infrastructure

This provisions the KMS CMK, the versioned private S3 bucket, and a
least-privilege IAM user + access key.

## Synthesize (no AWS calls)

`cdk synth` only renders the CloudFormation template — safe to run anytime,
needs no credentials. Use it to sanity-check before deploying.

```bash
cd devops/cdk
uv venv && uv pip install -e .      # or: python3 -m venv .venv && .venv/bin/pip install -e .
cdk synth                            # or: npx --yes aws-cdk@latest synth
```

If `cdk synth` reports a **cloud assembly schema version mismatch**, your global
`cdk` CLI is older than `aws-cdk-lib`; use `npx --yes aws-cdk@latest synth` or
`npm install -g aws-cdk@latest` (see cookbook 01).

## Deploy

```bash
cd devops/cdk
cdk deploy                           # add --profile <name> for a named profile
```

Approve the IAM changes when prompted.

## Capture the outputs

On success, CDK prints the stack outputs. Re-print them any time with:

```bash
aws cloudformation describe-stacks --stack-name OrbkeyStack \
  --query "Stacks[0].Outputs" --output table
```

```
OrbkeyStack.region            = us-east-1
OrbkeyStack.account_id        = 123456789012
OrbkeyStack.bucket_name       = orbkeystack-orbkeybucket-xxxxxxxx
OrbkeyStack.vault_prefix      = vaults/default/
OrbkeyStack.vault_object_key  = vaults/default/vault.bin
OrbkeyStack.kms_key_arn       = arn:aws:kms:us-east-1:123456789012:key/....
OrbkeyStack.access_key_id     = AKIA....
OrbkeyStack.secret_access_key = ....
```

## How the outputs map to orbkey config

The orbkey CLI reads non-secret locators from
`~/.config/orbkey/config.json` (or `$XDG_CONFIG_HOME/orbkey/config.json`) in
**snake_case** — exactly:

```json
{
  "bucket": "orbkeystack-orbkeybucket-xxxxxxxx",
  "kms_key_id": "arn:aws:kms:us-east-1:123456789012:key/....",
  "object_key": "vaults/default/vault.bin"
}
```

Output → config field translation:

| CDK output | goes to | where |
|---|---|---|
| `bucket_name` | `bucket` | `config.json` |
| `kms_key_arn` | `kms_key_id` | `config.json` (the SDK accepts the key **ARN** as `KeyId`) |
| `vault_object_key` | `object_key` | `config.json` (default `vaults/default/vault.bin`) |
| `account_id` | account id | `keychain.json` (via first-run form) |
| `region` | region | `keychain.json` (via first-run form) |
| `access_key_id` | IAM key id | `keychain.json` (via first-run form) |
| `secret_access_key` | IAM secret | `keychain.json` (via first-run form) |

You normally do **not** hand-write `config.json` — the first-run form (cookbook
03) writes it for you. The mapping is documented here so you can verify or
repair it by hand if needed.

## ⚠️ The secret access key is sensitive

`secret_access_key` appears in CloudFormation outputs and the console. For a
single-user self-hosted tool this is acceptable, but:

1. **Retrieve it once** and paste it into orbkey's first run.
2. **Treat it as sensitive** — it is one half of your recovery authority.
3. **Optionally rotate after first run** (replace the key from the IAM console
   or by re-deploying after rolling the access key; then update orbkey with
   `/rotate` → *IAM key*). See cookbook 04.

### Keeping the secret out of CloudFormation (optional)

If you'd rather not have the secret in stack outputs, edit
`devops/cdk/orbkey_stack.py`: remove the `secret_access_key` `CfnOutput` and
uncomment the AWS Secrets Manager block at the bottom (~$0.40/mo + a retrieval
step). Retrieve it later with:

```bash
aws secretsmanager get-secret-value --secret-id orbkey/iam-access-key \
  --query SecretString --output text
```

Next: [03-first-run.md](03-first-run.md).
