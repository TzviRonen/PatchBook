#!/usr/bin/env bash
# One-time setup for local PatchBook development.
# Installs the Ruby + Jekyll toolchain needed to build and preview the site.
#
# Usage: ./setup.sh
set -euo pipefail

echo "[*] PatchBook setup — installing the Ruby + Jekyll toolchain"

# 1. Ruby (+ headers/compiler for native gems)
if command -v ruby >/dev/null 2>&1; then
  echo "[=] Ruby already installed: $(ruby --version)"
else
  echo "[*] Installing Ruby via apt..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq ruby-full build-essential
fi

# 2. Jekyll + the plugins this site uses (see Gemfile)
if command -v jekyll >/dev/null 2>&1; then
  echo "[=] Jekyll already installed: $(jekyll --version)"
else
  echo "[*] Installing Jekyll gems..."
  sudo gem install --no-document jekyll bundler jekyll-feed jekyll-seo-tag webrick
fi

echo
echo "[+] Setup complete."
echo "    ruby:   $(ruby --version)"
echo "    jekyll: $(jekyll --version)"
echo
echo "    Next:  ./serve.sh        # build + serve, then open the printed URL"
