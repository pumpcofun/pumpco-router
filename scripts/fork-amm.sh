#!/usr/bin/env bash
# Local validator carrying pump.fun's bonding curve AND PumpSwap, with a real
# graduated pool cloned from mainnet, so both venues can be exercised against
# the actual programs rather than a mock.
SP="C:/Users/offic/AppData/Local/Temp/claude/C--Users-offic-Projects-awaken/45bd37e7-d269-45b0-9ec0-7111c4e97b3d/scratchpad"
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"

exec solana-test-validator --reset --quiet \
  --ledger "$SP/amm-ledger" \
  --url "$RPC" \
  --clone-upgradeable-program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P \
  --clone-upgradeable-program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA \
  --clone-upgradeable-program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ \
  `# --- PumpSwap: every account from a known-good mainnet buy ---`   --maybe-clone EuobJ9jJaJhW6EJDTi5Wjw7NkQqznCkrW9Ly8vuy3D93   --maybe-clone ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw   --maybe-clone EvWwHE1zjYv4gJjDCvtbdjUK6vsqSXyu9R5w2Lvhpump   --maybe-clone So11111111111111111111111111111111111111112   --maybe-clone DKdMJ241FK3W57RiUeNWvFmxQUvrQDcoSDF5rZFtDG9T   --maybe-clone GHsbvCJcWoEnxYRJFGnLgzbgHj3Yv7d63u2VpF3ivgyP   --maybe-clone 62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV   --maybe-clone 94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb   --maybe-clone 2N4nFkvSj13gJyXwUy4nbrxVWFMCJzrW356rK2UTzJcS   --maybe-clone 5qCBGXF6FExpxNJWgFLSwzwW3B8gaKsPKuAHd5d4UZk6   --maybe-clone C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw   --maybe-clone 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx   --maybe-clone GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR   --maybe-clone 4RBFvMn8pLDAe95W16S2RB2GbzSY4dJ1K3TaaRHwHvCr   --maybe-clone 5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD   --maybe-clone CASRL2zkwDnppxEFQ4LgdwgR9pdz5Q8R8nEMKVZ9QoLp   `# --- bonding curve: the token used in the curve tests ---` \
  --maybe-clone 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf \
  --maybe-clone CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM \
  --maybe-clone 4JzHAN3MgpRK7dgKg1SXuXcLiyH88GEQQsFE12XEpump \
  --maybe-clone 454nCttsWVwQcGiFDvYGeYrsSDnzdAZtX8nqUKoMaGuW \
  --maybe-clone GfPehpw1Ve62Zo2bYLMTbu73Fv6tyHKq9Z7uPTFoP7Hw \
  --maybe-clone 7ciFAiGp4rtzEcMUHor5N1Nk1qG84NcjTVwpsbbKRp2F \
  --maybe-clone Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1 \
  --maybe-clone Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y \
  --maybe-clone 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt \
  --maybe-clone BdJ7Nc4G2vxr7R1QgMJq3Frg4BdG27MDfFuzAB7jVc6o \
  --maybe-clone A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW \
  --bpf-program pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy \
    /c/Users/offic/Projects/pumpco-router/target/deploy/pumpco_router.so
