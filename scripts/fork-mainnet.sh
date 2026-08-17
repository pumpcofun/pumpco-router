#!/usr/bin/env bash
# Local validator with pump.fun's real program and a live bonding curve cloned
# from mainnet, so the router's CPI is exercised against the actual program.
SP="C:/Users/offic/AppData/Local/Temp/claude/C--Users-offic-Projects-awaken/45bd37e7-d269-45b0-9ec0-7111c4e97b3d/scratchpad"
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"

exec solana-test-validator --reset --quiet \
  --ledger "$SP/test-ledger" \
  --url "$RPC" \
  --clone-upgradeable-program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P \
  --clone-upgradeable-program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ \
  --clone 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf \
  --clone CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM \
  --clone 4JzHAN3MgpRK7dgKg1SXuXcLiyH88GEQQsFE12XEpump \
  --clone 454nCttsWVwQcGiFDvYGeYrsSDnzdAZtX8nqUKoMaGuW \
  --clone GfPehpw1Ve62Zo2bYLMTbu73Fv6tyHKq9Z7uPTFoP7Hw \
  --clone 7ciFAiGp4rtzEcMUHor5N1Nk1qG84NcjTVwpsbbKRp2F \
  --clone Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1 \
  --clone Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y \
  --clone 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt \
  --maybe-clone BdJ7Nc4G2vxr7R1QgMJq3Frg4BdG27MDfFuzAB7jVc6o \
  --maybe-clone A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW \
  --bpf-program pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy \
    /c/Users/offic/Projects/pumpco-router/target/deploy/pumpco_router.so
