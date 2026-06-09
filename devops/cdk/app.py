#!/usr/bin/env python3
"""CDK app entry point for orbkey."""

from __future__ import annotations

import aws_cdk as cdk
from orbkey_stack import OrbkeyStack

app = cdk.App()
OrbkeyStack(
    app,
    "OrbkeyStack",
    # Uses the account/region from your current AWS CLI environment.
    env=cdk.Environment(),
    description="orbkey — AWS-backed local-first secrets vault",
)
app.synth()
