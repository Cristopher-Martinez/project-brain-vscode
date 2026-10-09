#!/bin/bash
# Test TEI embedding endpoint
python3 -c '
import json
with open("/tmp/tei_test.json","w") as f:
    json.dump({"model":"BAAI/bge-small-en-v1.5","input":["hello world"]},f)
'
curl -s -X POST http://brain_embeddings:80/v1/embeddings \
  -H "Content-Type: application/json" \
  -d @/tmp/tei_test.json | python3 -c '
import sys, json
r = json.load(sys.stdin)
dims = len(r["data"][0]["embedding"])
m = r["model"]
print(f"OK model={m} dims={dims}")
'
