#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PAD_URL="${1:-${PAD_URL:-${PHONEPAD_PUBLIC_URL:-}}}"
PAD_TOKEN="${2:-${PAD_TOKEN:-${PHONEPAD_ACCESS_TOKEN:-}}}"
INTERVAL="${3:-0.05}"

if [[ -z "$PAD_URL" || -z "$PAD_TOKEN" ]]; then
  echo "Usage: $0 <pad_url> <token> [interval_seconds]"
  echo "Example: $0 https://phonepad.nickesselman.nl abc123 0.05"
  echo "Or set env vars: PAD_URL=... PAD_TOKEN=... $0"
  echo "Or create .env with PHONEPAD_PUBLIC_URL and PHONEPAD_ACCESS_TOKEN"
  exit 1
fi

while true; do
  curl -s "${PAD_URL%/}/state?token=${PAD_TOKEN}"
  echo
  sleep "$INTERVAL"
done
