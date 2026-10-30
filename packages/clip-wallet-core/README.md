# @clip-wallet/core

Clip Wallet's shared contract: networks, assets, the Vault and ChainModule interfaces, DecodedRequest, ClipError.

`src/` is a verbatim copy of the same folder in the public [ColdAI-org/clip-wallet](https://github.com/ColdAI-org/clip-wallet) repository, at the commit recorded in `UPSTREAM`.
There is no build step: `package.json` points straight at `src/index.ts`.

- Licence: MIT, see `LICENSE` in this folder.
- Do not edit `src/` here: change it upstream, then copy the new version over and update `UPSTREAM`.
- To check the copy, check out the commit named in `UPSTREAM` in a clone of the upstream repository, then run `diff -r <clone>/<folder of @clip-wallet/core>/src src` from this folder. No output means the copy is exact.
