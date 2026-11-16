#!/usr/bin/env bash
# A stand-in for voice/stt.py in tier 2: local whisper is the fallback when Soniox
# fails, and a test must not download a model to prove that it is used.
echo "heard on this machine"
