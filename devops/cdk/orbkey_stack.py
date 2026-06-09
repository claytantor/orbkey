"""orbkey infrastructure stack.

Provisions exactly what the orbkey TUI (TypeScript / Ink, AWS SDK v3) needs and
nothing more:

* a symmetric KMS CMK (rotation on) that the IAM user may ``Decrypt``,
  ``GenerateDataKey`` and ``DescribeKey`` with;
* a private, versioned, TLS-only S3 bucket (S3-managed SSE — the payload is
  already KMS-enveloped by the app, so we avoid paying for double-KMS);
* a least-privilege IAM user + access key scoped to the bucket's vault prefix
  and the CMK only.

The CMK grant includes ``kms:DescribeKey`` because the SDK-v3 client validates
credentials on first run / unlock with ``kms:DescribeKey`` (see
``src/core/aws.ts::validateCreds`` in the orbkey-ts repo). Without it, first run
fails closed with AccessDenied even though encrypt/decrypt would work.

The S3 ``s3:GetObject`` / ``s3:PutObject`` grant on the vault prefix is what
authorizes the sync engine's optimistic-concurrency conditional writes
(``If-Match`` / ``If-None-Match`` on PutObject) and HEAD reads — there is no
separate ``s3:HeadObject`` IAM action; a HEAD is authorized by ``s3:GetObject``,
and the conditional headers are authorized by ``s3:PutObject``.

Outputs include the access key id and secret. The secret appears in
CloudFormation outputs / the console — acceptable for a single-user self-hosted
tool, but treat it as sensitive and rotate after first run (see cookbook 02).
An optional AWS Secrets Manager delivery is included below, commented out.
"""

from __future__ import annotations

from aws_cdk import (
    Aws,
    CfnOutput,
    RemovalPolicy,
    Stack,
)
from aws_cdk import (
    aws_iam as iam,
)
from aws_cdk import (
    aws_kms as kms,
)
from aws_cdk import (
    aws_s3 as s3,
)
from constructs import Construct

VAULT_NAME = "default"
VAULT_PREFIX = f"vaults/{VAULT_NAME}/"
# Must match orbkey-ts: src/core/config.ts DEFAULT_OBJECT_KEY and
# src/core/sync.ts VaultLocation default object key.
VAULT_OBJECT_KEY = f"{VAULT_PREFIX}vault.bin"


class OrbkeyStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # --- KMS CMK ---------------------------------------------------------
        key = kms.Key(
            self,
            "OrbkeyKey",
            description="orbkey vault data-key wrapping CMK",
            enable_key_rotation=True,
            alias=f"alias/orbkey-{VAULT_NAME}",
            removal_policy=RemovalPolicy.RETAIN,
        )

        # --- S3 bucket -------------------------------------------------------
        bucket = s3.Bucket(
            self,
            "OrbkeyBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            versioned=True,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,  # adds an aws:SecureTransport deny policy
            removal_policy=RemovalPolicy.RETAIN,
        )

        # --- IAM user (least privilege) -------------------------------------
        user = iam.User(self, "OrbkeyUser")

        # KMS: Decrypt + GenerateDataKey (envelope encryption) and DescribeKey
        # (first-run / unlock credential validation), only on this CMK.
        key.grant(user, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey")

        # S3: list the bucket (scoped to the vault prefix), and get/put only
        # under the vault prefix. GetObject also authorizes HEAD; PutObject also
        # authorizes the If-Match / If-None-Match conditional writes.
        user.add_to_policy(
            iam.PolicyStatement(
                actions=["s3:ListBucket"],
                resources=[bucket.bucket_arn],
                conditions={"StringLike": {"s3:prefix": [f"{VAULT_PREFIX}*"]}},
            )
        )
        user.add_to_policy(
            iam.PolicyStatement(
                actions=["s3:GetObject", "s3:PutObject"],
                resources=[bucket.arn_for_objects(f"{VAULT_PREFIX}*")],
            )
        )

        # --- access key ------------------------------------------------------
        access_key = iam.CfnAccessKey(self, "OrbkeyAccessKey", user_name=user.user_name)

        # --- outputs ---------------------------------------------------------
        # Translate these into ~/.config/orbkey/config.json (snake_case):
        #   bucket_name      -> "bucket"
        #   kms_key_arn      -> "kms_key_id"   (the SDK accepts the key ARN)
        #   vault_object_key -> "object_key"   ("vaults/default/vault.bin")
        # The access key id/secret + account_id + region go into keychain.json
        # via the orbkey first-run form.
        CfnOutput(self, "region", value=Aws.REGION)
        CfnOutput(self, "account_id", value=Aws.ACCOUNT_ID)
        CfnOutput(self, "bucket_name", value=bucket.bucket_name)
        CfnOutput(self, "vault_prefix", value=VAULT_PREFIX)
        CfnOutput(self, "vault_object_key", value=VAULT_OBJECT_KEY)
        CfnOutput(self, "kms_key_arn", value=key.key_arn)
        CfnOutput(self, "access_key_id", value=access_key.ref)
        CfnOutput(
            self,
            "secret_access_key",
            value=access_key.attr_secret_access_key,
            description="SENSITIVE — retrieve once, then consider rotating (cookbook 02).",
        )

        # --- OPTIONAL: deliver the secret via Secrets Manager instead --------
        # Uncomment to keep the secret out of CloudFormation outputs (~$0.40/mo
        # + a retrieval step). Then drop the `secret_access_key` CfnOutput above.
        #
        # from aws_cdk import aws_secretsmanager as sm
        # sm.CfnSecret(
        #     self,
        #     "OrbkeySecret",
        #     name="orbkey/iam-access-key",
        #     secret_string=(
        #         f'{{"access_key_id":"{access_key.ref}",'
        #         f'"secret_access_key":"{access_key.attr_secret_access_key}"}}'
        #     ),
        # )
