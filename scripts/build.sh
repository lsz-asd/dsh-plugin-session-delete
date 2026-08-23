#!/usr/bin/env bash
set -euo pipefail

mkdir -p lib
cp src/index.js lib/index.js
cp src/client.js lib/client.js

printf '%s\n' 'Built lib/index.js and lib/client.js'
