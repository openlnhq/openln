# Vendored oracle sources

Byte-for-byte copies of the production BoltCard card installer from
[lawalletio/card-installer](https://github.com/lawalletio/card-installer)
(MIT license, see `LICENSE` here), commit `15c1da4ca687751d2b7073af6b153d661d20b967`:

- `Ntag424.js` — `src/class/Ntag424.js` (the card engine used as the oracle)
- `Cmac.js` — `src/utils/Cmac.js` (its CMAC helper dependency)

`tests/oracle-prepare.mjs` transforms `Ntag424.js` (import specifier rewrites
only) into `lawalletio-ntag424.mjs` and runs it against the same mock card as
our engine, asserting the APDU streams are byte-for-byte identical.
