# @clip-wallet/vault

The only Clip Wallet package that touches recovery phrases and private keys: derivation, encrypted storage, approval-bound signing, passkey unlock.

`src/` is a verbatim copy of the same folder in the public [ColdAI-org/clip-wallet](https://github.com/ColdAI-org/clip-wallet) repository, at the commit recorded in `UPSTREAM`.
There is no build step: `package.json` points straight at `src/index.ts`.

- Licence: Apache-2.0, as upstream. `LICENSE` in this folder has the text, and the repository's `NOTICE` credits Clip Wallet.
- Do not edit `src/` here: change it upstream, then copy the new version over and update `UPSTREAM`.
- To check the copy, check out the commit named in `UPSTREAM` in a clone of the upstream repository, then run `diff -r <clone>/<folder of @clip-wallet/vault>/src src` from this folder. No output means the copy is exact.
