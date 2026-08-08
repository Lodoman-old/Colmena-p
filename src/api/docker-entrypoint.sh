#!/bin/sh
set -e

mkdir -p /app/uploads/evidencias
exec node dist/index.js
