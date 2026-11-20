# Third-party notices

## Original protocol implementation

The TypeScript protocol adapters under `cloudflare/src/engine/` derive from the Python implementation retained under `jrxy-engine/`. Original Web behavior is compared against `web-server/app.py` for task results, schedules, and notifications.

The supplied engine identifies its upstream as [maserpoassr/jrxy-engine](https://github.com/maserpoassr/jrxy-engine), based on the auto-cpdaily project lineage. The inherited license is **Mozilla Public License 2.0**. Copies are retained in `LICENSE` and `jrxy-engine/LICENSE`. Brand substitutions do not remove original license obligations or credit.

The Python reference sources are not deployed into Cloudflare Workers. Photo/OCR/other legacy task code in that reference directory is not an enabled feature of `jrxy_auto_cf`.

## Protocol constants

The fixed DES/AES/RSA material in `cloudflare/src/engine/constants.ts` and the referenced Python scripts is inherited protocol material used for interoperability. It is not a user's password, Cloudflare token, deployment secret, or data-encryption key.

Do not use those constants to protect application data. Stored account configuration is encrypted with a separately generated `ENCRYPTION_KEY` configured as a Cloudflare Secret. Actual credentials and runtime data are excluded from this repository.

## Runtime and development dependencies

- `tldts` and `tldts-core`: MIT-licensed domain/public-suffix parsing used for Cookie scope validation. Their packaged license and public-suffix data notices remain in the installed packages.
- Wrangler, workerd tooling, Vitest, TypeScript, and type definitions: development/build dependencies, with licenses supplied by their packages.

See `cloudflare/package.json` and `cloudflare/package-lock.json` for the exact dependency versions. `node_modules/` and build artifacts are not committed.

## Educational use

This project is intended for learning and research on accounts the operator owns or is explicitly authorized to use. The project is not an official service and does not authorize misuse of any third-party system.
