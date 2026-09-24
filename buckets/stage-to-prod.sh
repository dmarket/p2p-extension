#!/bin/bash
# Copy the stage config over the local prod one, to review and publish with buckets/upload.sh prod.
. "$(dirname "$0")/common.sh"

cp "$(local_for stage)" "$(local_for prod)"
git --no-pager diff --stat -- "$(local_for prod)"
