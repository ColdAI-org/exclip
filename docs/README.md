# ExClip documentation

| Page | Read it if you want to |
|---|---|
| [Concepts](concepts.md) | Understand how a swap goes from a click to settlement, market swaps and limit orders, and the words the rest of these pages use |
| [Architecture](architecture.md) | See the parts, how they talk, the two origins, where each key lives, and what the server and the browser keep |
| [Configuration](configuration.md) | Look up every setting in `exclip.config.ts`, its default, and the environment variables that override it |
| [Self-hosting](self-hosting.md) | Run ExClip in production: Docker or a plain Node host, a reverse proxy, the two origins and their headers, backups, monitoring and upgrades |
| [Branding](branding.md) | Run ExClip under your own name, logo and colours without forking it, and keep the text readable |
| [The passkey wallet](wallet.md) | Know what the built-in wallet does, how to back it up and get back in, and what the server can and can't see |
| [Embedded wallet design](embedded-wallet.md) | Review the passkey wallet in depth: its threat model, signing policy, price checks, messages and release controls |
| [Fees](fees.md) | Know what a swap costs, how an operator's fee works, and why every part refuses a fee nobody configured |
| [Security](security.md) | See the threat model, the invariants and the test behind each one, known limitations, and how to report a problem |
| [API](api.md) | Call the server: every route with its method, path, request, response and rate limit |
| [Development](development.md) | Work on the code: the repository layout, scripts and tests, and how to add a network or an asset |
| [Troubleshooting](troubleshooting.md) | Fix a server that won't start, a build that fails, a quote that doesn't load, or a wallet window that won't open |
| [FAQ](faq.md) | Find short answers to common questions from users and operators |

Elsewhere in the repository:

- [README](../README.md): what ExClip is, a quick start and the project's
  status.
- [Brand kit](../brand/README.md): ExClip's mark, wordmark and colours, for
  ExClip itself.
- [Contributing](../CONTRIBUTING.md) and the
  [code of conduct](../CODE_OF_CONDUCT.md).
- [Security policy](../SECURITY.md): how to report a vulnerability.
- [Changelog](../CHANGELOG.md).

ExClip is a front end for [SODAX](https://sodax.com). Where these pages and
SODAX's own documentation disagree about SODAX, SODAX's documentation wins;
please open an issue.
