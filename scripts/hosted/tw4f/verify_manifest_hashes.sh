#!/usr/bin/env bash
# TW-4F H1: re-computes the sha256 of every migration listed in docs/twilio/TW-4F_Hosted_Apply_Manifest.md from Git and compares it with the manifest.
# Git blobs only; no database, no network. LF-normalized exactly as the manifest states: git show <ref>:<path> | tr -d '\r' | sha256sum.
#   usage: scripts/hosted/tw4f/verify_manifest_hashes.sh [ref]     (default: main; pass the ref/commit the apply will be cut from)
# Table rows it reads look like:  | 20261119090000 | <file>.sql | <64-hex sha256> | <64-hex rollback sha256> | ...
# Exit 0 only if every row matches AND every migration on the ref in the manifest range appears exactly once in the manifest.
set -euo pipefail
REF="${1:-main}"
ROOT="$(git rev-parse --show-toplevel)"
DOC="$ROOT/docs/twilio/TW-4F_Hosted_Apply_Manifest.md"
DIR=src/lib/supabase/migrations
bad=0; n=0; declare -A seen
while IFS='|' read -r _ stamp file sha rbsha _; do
  stamp="$(echo "$stamp" | tr -d ' `')"; file="$(echo "$file" | tr -d ' `')"; sha="$(echo "$sha" | tr -d ' `')"; rbsha="$(echo "$rbsha" | tr -d ' `')"
  [[ "$stamp" =~ ^[0-9]{14}$ && "$sha" =~ ^[0-9a-f]{64}$ ]] || continue
  [[ -n "${seen[$stamp]:-}" ]] && { echo "DUPLICATE manifest row: $stamp"; bad=1; }; seen[$stamp]=1
  if ! git cat-file -e "$REF:$DIR/$file" 2>/dev/null; then echo "not on $REF (pending/slot): $stamp $file"; continue; fi
  n=$((n+1))
  got="$(git show "$REF:$DIR/$file" | tr -d '\r' | sha256sum | cut -d' ' -f1)"
  [ "$got" = "$sha" ] || { echo "MISMATCH forward $stamp: manifest $sha, git $got"; bad=1; }
  if [[ "$rbsha" =~ ^[0-9a-f]{64}$ ]]; then
    rbfile="${file%.sql}_rollback.sql"
    rgot="$(git show "$REF:$DIR/rollback/$rbfile" | tr -d '\r' | sha256sum | cut -d' ' -f1)"
    [ "$rgot" = "$rbsha" ] || { echo "MISMATCH rollback $stamp: manifest $rbsha, git $rgot"; bad=1; }
  fi
done < <(grep -E '^\| `?[0-9]{14}' "$DOC")
# every forward migration in the TW-4/TW-4F range on the ref must be in the manifest
for f in $(git ls-tree -r --name-only "$REF" "$DIR" | grep -E "/(2026111[9]|202611[2-3]|202612[01])[0-9]*_[^/]*\.sql$" | grep -v /rollback/); do
  s="$(basename "$f" | cut -c1-14)"; [ -n "${seen[$s]:-}" ] || { echo "ON $REF BUT NOT IN MANIFEST: $s"; bad=1; }
done
echo "checked $n migrations on $REF"; [ "$bad" = 0 ] && echo "MANIFEST HASHES OK" || { echo "MANIFEST HASH CHECK FAILED"; exit 1; }
