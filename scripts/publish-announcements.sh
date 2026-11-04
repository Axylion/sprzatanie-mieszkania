#!/usr/bin/env bash
# Run only after successful cleanup. The contents API's SHA check prevents lost updates.
set -euo pipefail
if git diff --quiet -- announcements.json; then
  echo 'No changes; no commit created.'
  echo 'changed=false' >> "$GITHUB_OUTPUT"
  exit 0
fi
payload=$(mktemp)
trap 'rm -f "$payload"' EXIT
python3 - <<'PY' > "$payload"
import base64
import json
from pathlib import Path
import subprocess
print(json.dumps({
    'message': 'Remove announcements 30 calendar days after expiry',
    'branch': 'main',
    'sha': subprocess.check_output(['git', 'rev-parse', 'HEAD:announcements.json'], text=True).strip(),
    'content': base64.b64encode(Path('announcements.json').read_bytes()).decode('ascii'),
}))
PY
gh api --method PUT "repos/${GITHUB_REPOSITORY}/contents/announcements.json" --input "$payload" --silent
echo 'changed=true' >> "$GITHUB_OUTPUT"
